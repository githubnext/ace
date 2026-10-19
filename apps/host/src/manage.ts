import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { resolve } from "node:path";

import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";

import type { Changes, ChannelInfo, ModelRef } from "@ace/channel/protocol";
import { available, choose, usable } from "@ace/channel/models";

import * as catalog from "./catalog";
import { Connection, hostedAuth, request } from "./client";
import { frozen } from "./compute";
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

/**
 * Forks a channel into a new sibling channel in its project, seeded with the source's summary and
 * a link back to it. The root chat's lane continues in a new lane from its current commit, where
 * uncommitted work stays behind. The source is only read, never written.
 */
export async function fork(id: string, author: string): Promise<catalog.Listing> {
	const source = catalog.read(id);
	if (source.compute) {
		throw new Error(
			"Cloud compute channels can't be forked yet: their lanes are in the container.",
		);
	}
	const connection = await Connection.open(id);
	let info: ChannelInfo;
	let changes: Changes;
	try {
		[info, changes] = await Promise.all([
			connection.request<ChannelInfo>({ op: "info" }),
			connection.request<Changes>({ op: "changes" }),
		]);
	} finally {
		connection.close();
	}
	const root = info.chats.find((chat) => chat.id === ROOT_CONVERSATION_ID);
	const refs = await git(source.project, [
		"for-each-ref",
		"--format=%(refname:lstrip=2)",
		"refs/heads/",
	]);
	const branches = new Set(refs.stdout.split("\n").map((ref) => ref.split("/")[0]!));
	const record = catalog.fork(source, root?.model || source.model, branches);
	const lane = changes.lane
		? {
			name: changes.lane,
			path: `${source.project}/.lane/trees/${record.prefix}/${changes.lane}`,
			// The source's fork point, so the Diff shows its commits as well as the fork's own.
			base: changes.base,
		}
		: undefined;
	if (lane) await newLane(source.project, `${record.prefix}/${lane.name}`, changes.head);
	const saved = catalog.save(lane ? { ...record, lane } : record);
	await request(record.id, { op: "say", author, text: seed(info, changes, lane) });
	return saved;
}

async function newLane(project: string, branch: string, base: string): Promise<void> {
	// Ace's lane is in the helpers directory on the adopted PATH, which `env` makes Bun search.
	const child = Bun.spawn(["lane", "new", branch, "--base", base], {
		cwd: project,
		env: process.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, status] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (status !== 0) {
		throw new Error(`Could not start lane ${branch}: ${(stderr || stdout).trim()}`);
	}
}

function seed(info: ChannelInfo, changes: Changes, lane: { name: string } | undefined): string {
	const lines = [`Forked from #${info.name} (channel ${info.id}).`];
	if (info.summary) lines.push("", info.summary);
	if (lane) {
		const dirty = changes.dirs?.length
			|| changes.files.some((file) => file.state === "uncommitted" || file.state === "untracked");
		lines.push(
			"",
			`Lane ${lane.name} continues from ${changes.branch || "its lane"} at ${
				changes.head.slice(0, 12)
			}.${dirty ? " Its uncommitted changes stayed in the source." : ""}`,
		);
	}
	return lines.join("\n");
}

export async function kill(id: string): Promise<void> {
	// Only the owner reaches this, through archive, delete, or ace kill.
	const { hosted, compute, owner } = catalog.read(id);
	if (hosted) {
		if (compute && await frozen(id)) return;
		return request<void>(id, { op: "kill", author: owner });
	}
	const connection = await Connection.running(id);
	if (!connection) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			(async () => {
				await connection.request({ op: "kill", author: owner });
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
	const { hosted, compute } = catalog.read(id);
	if (compute && await frozen(id)) return false;
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
	const { project, hosted, compute } = catalog.read(id);
	if (compute) {
		// The service's DELETE also deletes the channel and ends its run, which a frozen channel
		// (a failed start) would refuse to the host's own kill.
		const response = await fetch(`${hosted}/workspaces/${id}`, {
			method: "DELETE",
			headers: await hostedAuth(),
		});
		if (!response.ok) {
			const reason = await refusal(response, "Cloud compute");
			throw new Error(`${reason} The channel and its cloud workspace were kept.`);
		}
	} else if (hosted) {
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
