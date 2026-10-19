/**
 * The cloud compute beta: a hosted channel whose workspace is a container on the team's compute
 * service (services/compute) instead of this host. Its record keeps `hosted`, so clients reach
 * the channel at the service's `/channels/:id` like any hosted channel.
 */
import { realpathSync } from "node:fs";

import type { ModelRef } from "@ace/channel/protocol";

import * as catalog from "./catalog";
import { hostedAuth, rejection } from "./client";
import { project as repoOf } from "./github";
import { refusal } from "./http";
import { project } from "./manage";
import { compute } from "./preferences";
import { git } from "./projects";

/** Startup clones the repository; the service gives its own container 120 seconds to boot. */
const CONNECT_WAIT = 5 * 60_000;

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
	let response: Response;
	try {
		response = await fetch(url, {
			...init,
			headers: { ...(await hostedAuth()), "content-type": "application/json" },
		});
	} catch (error) {
		throw new Error(`Could not reach ${new URL(url).host}: ${(error as Error).message}.`, {
			cause: error,
		});
	}
	if (response.status === 401) throw new Error(await rejection(response, "Cloud compute"));
	if (!response.ok) throw new Error(await refusal(response, "Cloud compute"));
	return await response.json() as T;
}

async function author(root: string): Promise<{ name: string; email: string }> {
	const [name, email] = await Promise.all(
		["user.name", "user.email"].map(async (key) =>
			(await git(root, ["config", "--get", key])).stdout.trim()
		),
	);
	if (!name || !email) {
		throw new Error("Set Git's user.name and user.email for this project to run it in the cloud.");
	}
	return { name, email };
}

/** Whether this host can move a channel in `root` to a cloud workspace. */
export async function available(root: string): Promise<boolean> {
	const { enabled, url } = compute();
	return enabled && !!url && !!(await repoOf(root));
}

type Lane = { path: string; branch: string; base?: string };

async function output(dir: string, args: string[]): Promise<string> {
	const result = await git(dir, args);
	if (result.status !== 0) {
		throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
	}
	return result.stdout.trim();
}

/** A cloud workspace starts from a fresh clone, so lanes travel only as pushed branches. */
async function lanes(root: string, prefix: string): Promise<Lane[]> {
	// Git lists real paths; the channel's records name lanes under its project path.
	const trees = `${realpathSync(root)}/.lane/trees/${prefix}/`;
	const found = (await output(root, ["worktree", "list", "--porcelain"])).split("\n\n").flatMap(
		(block) => {
			const path = /^worktree (.+)$/m.exec(block)?.[1];
			if (!path?.startsWith(trees)) return [];
			const name = path.slice(trees.length);
			return [{
				path: `${root}/.lane/trees/${prefix}/${name}`,
				name,
				head: /^HEAD (\w+)$/m.exec(block)?.[1],
				branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1],
			}];
		},
	);
	if (!found.length) return [];
	const pushed = new Map(
		(await output(root, ["ls-remote", "origin", `refs/heads/${prefix}/*`])).split("\n")
			.filter(Boolean)
			.map((line) => {
				const [commit, ref] = line.split("\t");
				return [ref!.slice("refs/heads/".length), commit];
			}),
	);
	const unready: string[] = [];
	const ready: Lane[] = [];
	for (const lane of found) {
		if (!lane.branch) unready.push(`${lane.name} (no branch)`);
		else if (await output(lane.path, ["status", "--porcelain"])) {
			unready.push(`${lane.name} (uncommitted changes)`);
		} else if (pushed.get(lane.branch) !== lane.head) unready.push(`${lane.name} (not pushed)`);
		else {
			const base = (await git(root, ["config", "--get", `lane.${lane.branch}.base`])).stdout.trim();
			ready.push({ path: lane.path, branch: lane.branch, ...(base ? { base } : {}) });
		}
	}
	if (unready.length) {
		throw new Error(
			`The cloud workspace starts from a fresh clone, so commit and push these lanes first, or remove them: ${
				unready.join(", ")
			}.`,
		);
	}
	return ready;
}

/**
 * What the compute service needs to adopt a moved channel. The channel's records name paths on
 * this host, so the workspace serves its clone at the same project path.
 */
export async function adoption(record: catalog.Listing) {
	const { url } = compute();
	if (!url || !(await available(record.project))) {
		throw new Error("Moving to a cloud workspace needs Cloud compute and a GitHub project.");
	}
	return {
		url,
		body: {
			repository: `https://github.com/${await repoOf(record.project)}.git`,
			owner: record.owner,
			author: await author(record.project),
			name: record.name,
			prefix: record.prefix,
			named: record.named,
			model: record.model,
			project: record.project,
			lanes: await lanes(record.project, record.prefix),
		},
	};
}

/** Creates the channel and its stopped workspace; `start` brings the workspace up. */
export async function create(
	dir: string,
	model: ModelRef | undefined,
	name: string | undefined,
): Promise<catalog.Listing> {
	const { enabled, url } = compute();
	if (!enabled || !url) throw new Error("Turn on Cloud compute in Settings → Beta first.");
	const root = await project(dir);
	const repo = await repoOf(root);
	if (!repo) throw new Error("Run in cloud needs a project with a GitHub repository.");
	const record: catalog.Listing = {
		...catalog.draft(root, model, name, url),
		compute: true,
		stopped: true,
	};
	await call(`${url}/workspaces/${record.id}/init`, {
		method: "POST",
		body: JSON.stringify({
			repository: `https://github.com/${repo}.git`,
			owner: record.owner,
			author: await author(root),
			name: record.name,
			prefix: record.prefix,
			named: record.named,
			model,
		}),
	});
	// The service has the channel now, so its record must exist even if starting fails.
	return catalog.save(record);
}

/** A failed start leaves the channel frozen: it runs nothing and refuses connections. */
export async function frozen(id: string): Promise<boolean> {
	const { hosted } = catalog.read(id);
	return (await call<{ frozen: boolean }>(`${hosted}/workspaces/${id}/status`)).frozen;
}

/** Checkpoints the workspace and stops its container; the chat stays readable while stopped. */
export async function stop(id: string): Promise<void> {
	const { hosted, compute } = catalog.read(id);
	if (!compute) throw new Error("The channel does not run on cloud compute");
	await call(`${hosted}/workspaces/${id}/stop`, { method: "POST", body: "{}" });
	catalog.write({ ...catalog.read(id), stopped: true });
}

/** Starting again after a failure is the retry: the service replaces an incomplete start. */
export async function start(id: string, waiting: (text: string | null) => void): Promise<void> {
	const { hosted, compute } = catalog.read(id);
	if (!compute) throw new Error("The channel does not run on cloud compute");
	// The service restores its checkpoint when it has one; only a workspace without one clones.
	const { checkpoint } = await call<{ checkpoint?: unknown }>(`${hosted}/workspaces/${id}/status`);
	waiting(
		checkpoint
			? "Resuming the cloud workspace from its checkpoint…"
			: "Starting the cloud workspace and cloning the repository…",
	);
	await call(`${hosted}/workspaces/${id}/start`, { method: "POST", body: "{}" });
	catalog.write({ ...catalog.read(id), stopped: undefined });
	waiting("Waiting for the cloud workspace to connect…");
	const deadline = Date.now() + CONNECT_WAIT;
	while (Date.now() < deadline) {
		const status = await call<{ runner: { connected: boolean } | null }>(
			`${hosted}/workspaces/${id}/status`,
		);
		if (status.runner?.connected) return waiting(null);
		await Bun.sleep(2000);
	}
	throw new Error("The cloud workspace started but did not connect within five minutes.");
}
