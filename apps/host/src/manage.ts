import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { resolve } from "node:path";

import type { ChannelInfo, ModelRef } from "@ace/channel/protocol";
import { available, choose, usable } from "@ace/channel/models";

import * as catalog from "./catalog";
import { Connection, hostedAuth, request } from "./client";
import { config } from "./config";
import { refusal } from "./http";
import { models as providers } from "./keys";
import { preference } from "./preferences";
import { checkout, git } from "./projects";
import { isInactive } from "./protocol";

export function parseModel(value: string): ModelRef {
	const split = value.indexOf("/");
	if (split < 1) throw new Error("A model is written provider/id, such as openai/gpt-6-astra");
	return { provider: value.slice(0, split), modelId: value.slice(split + 1) };
}

/** Models with credentials on this machine. */
export async function models(): Promise<ModelRef[]> {
	return available(providers());
}

export async function defaultModel(): Promise<ModelRef> {
	if (config.model) return parseModel(config.model);
	const saved = preference();
	const models = providers();
	// A saved default whose key expired or was removed must not block agents another key can run.
	if (saved && await usable(models, saved)) return saved;
	return choose(models);
}

/** The Git top level containing `dir`, which needs a commit for lanes to start from. */
export async function project(dir: string): Promise<string> {
	dir = resolve(dir === "~" ? homedir() : dir.startsWith("~/") ? homedir() + dir.slice(1) : dir);
	const result = await git(dir, ["rev-parse", "--show-toplevel"]);
	if (result.status === null) throw new Error("Git is unavailable. Check This Mac in Settings.");
	if (result.status !== 0) {
		throw new Error(`${dir} is not a Git repository. Initialize Git to start channels in it.`);
	}
	if ((await git(dir, ["rev-parse", "--verify", "-q", "HEAD"])).status !== 0) {
		throw new Error(`${dir} has no commits yet. Commit its files to start channels in it.`);
	}
	return result.stdout.trim();
}

/** Hosted channels are always reachable; local ones run while their worker does. */
export function isRunning(id: string): boolean {
	if (catalog.read(id).hosted) return true;
	return existsSync(catalog.paths(id).socket) && isWorkerAlive(id);
}

/** PID liveness also covers startup, before the worker has opened its listener. */
export function isWorkerAlive(id: string): boolean {
	try {
		const owner = Number(readFileSync(catalog.paths(id).pid, "utf8"));
		if (!Number.isSafeInteger(owner) || owner <= 0) return false;
		process.kill(owner, 0);
		return true;
	} catch {
		return false;
	}
}

/** What the hosting service stores for a channel whose workspace is this host. */
export function hostedConfig(record: catalog.Listing) {
	return {
		version: 2,
		id: record.id,
		name: record.name,
		prefix: record.prefix,
		named: record.named,
		owner: record.owner,
		project: record.project,
		lanes: catalog.paths(record.id).lanes,
		model: record.model,
		workspace: `host:${hostname()}`,
	};
}

/** Create a channel on a hosting service, with this host as its workspace. */
export async function host(
	dir: string,
	model: ModelRef | undefined,
	name: string | undefined,
	url: string,
) {
	// Saving the record starts the workspace link, so the service must have the channel first.
	const record = catalog.draft(dir, model, name, url.replace(/\/$/, ""));
	const headers = await hostedAuth();
	let response: Response;
	try {
		response = await fetch(`${record.hosted}/channels/${record.id}`, {
			method: "POST",
			headers,
			body: JSON.stringify(hostedConfig(record)),
		});
	} catch (error) {
		throw new Error(`Could not reach ${record.hosted}: ${(error as Error).message}.`, {
			cause: error,
		});
	}
	if (!response.ok) {
		throw new Error(
			`${await refusal(response, "The hosting service")} The channel was not created.`,
		);
	}
	return catalog.save(record);
}

export async function kill(id: string): Promise<void> {
	if (catalog.read(id).hosted) return request<void>(id, { op: "kill" });
	const connection = await Connection.running(id);
	if (!connection) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			(async () => {
				await connection.request({ op: "kill" });
				// The reply only confirms the abort; the worker closes sockets after storage and tools.
				await connection.closed;
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Channel ${id} did not close within 10 seconds`)),
					10_000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		connection.close();
	}
}

export async function archive(id: string, archived: boolean): Promise<catalog.Listing> {
	if (archived) await kill(id);
	const record = { ...catalog.read(id), archived };
	catalog.write(record);
	return record;
}

/** Dormant workers retire only once idle, so only a live worker can have work in progress. */
async function busy(id: string): Promise<boolean> {
	const { hosted } = catalog.read(id);
	const connection = hosted ? await Connection.hosted(hosted, id) : await Connection.running(id);
	if (!connection) return false;
	try {
		const { chats } = await connection.request<ChannelInfo>({ op: "info" });
		return chats.some((chat) => chat.busy);
	} finally {
		connection.close();
	}
}

/** Archives a project's inactive channels on this host, judged by this host's clock; returns their IDs. */
export async function archiveInactive(root: string): Promise<string[]> {
	const now = Date.now();
	const inactive = catalog.list().filter((record) => !record.archived && isInactive(record, now));
	const roots = await Promise.all(inactive.map((record) => checkout(record.project)));
	const open = inactive.filter((_, index) => roots[index]!.root === root);
	const idle = await Promise.all(open.map(async ({ id }) => (await busy(id)) ? undefined : id));
	const ids = idle.filter((id) => id !== undefined);
	await Promise.all(ids.map((id) => archive(id, true)));
	return ids;
}

/**
 * Kills the worker and keeps its lock, so a client still watching the channel cannot start another
 * worker over storage being removed. A worker that started before the lock is killed in turn.
 */
async function hold(id: string): Promise<void> {
	for (let wait = 50; wait < 5000; wait *= 2) {
		await kill(id);
		if (catalog.lock(id)) return;
		await Bun.sleep(wait);
	}
	throw new Error("The channel's worker kept restarting; try deleting it again");
}

/**
 * Removes the channel and the lane worktrees in its directory, which predate the lane CLI; lane
 * branches stay in the project. Lanes `lane new` created stay too, for `lane prune` or `lane rm`.
 */
export async function remove(id: string): Promise<void> {
	const { project, hosted } = catalog.read(id);
	if (hosted) {
		await kill(id);
		const response = await fetch(`${hosted}/channels/${id}`, {
			method: "DELETE",
			headers: await hostedAuth(),
		});
		if (!response.ok && response.status !== 404) {
			throw new Error(
				`${await refusal(response, "The hosting service")} The channel was not deleted.`,
			);
		}
	} else await hold(id);
	const { lanes } = catalog.paths(id);
	try {
		for (const lane of existsSync(lanes) ? readdirSync(lanes) : []) {
			await git(project, ["worktree", "remove", "--force", `${lanes}/${lane}`]);
		}
		catalog.remove(id);
	} catch (error) {
		if (!hosted) catalog.unlock(id);
		throw error;
	}
}
