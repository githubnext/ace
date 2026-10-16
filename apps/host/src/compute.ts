/**
 * The cloud compute beta: a hosted channel whose workspace is a container on the team's compute
 * service (services/compute) instead of this host. Its record keeps `hosted`, so clients reach
 * the channel at the service's `/channels/:id` like any hosted channel.
 */
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
