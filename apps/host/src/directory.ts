/**
 * The team's directory (services/directory): this host publishes its channels there and reads
 * everyone else's, so a channel stays listed while its host is asleep.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as catalog from "./catalog";
import { hostedAuth } from "./client";
import { failure, log } from "./log";
import type { Listing } from "./protocol";

const HEARTBEAT = 30_000;

/** `github` is the owner's GitHub login, so clients can show avatars for their messages. */
type Host = { name: string; login: string; github?: string; address?: string; seen: number };

const config = join(catalog.home, "directory.json");

export function url(): string | undefined {
	if (process.env.ACE_DIRECTORY) return process.env.ACE_DIRECTORY;
	if (existsSync(config)) return JSON.parse(readFileSync(config, "utf8")).url;
}

export function configure(value: string | undefined): void {
	if (value) writeFileSync(config, JSON.stringify({ url: value.replace(/\/$/, "") }));
	else rmSync(config, { force: true });
}

let known: { hosts: Host[]; channels: Listing[] } = { hosts: [], channels: [] };
let synced: number | undefined;
let error: string | undefined;

export function status() {
	return { url: url(), synced, error };
}

/** The directory's last answer; empty until it first responds or without a directory. */
export function read() {
	return known;
}

async function call(path: string, init?: RequestInit): Promise<Response> {
	const base = url();
	if (!base) throw new Error("No directory; see ace directory");
	const response = await fetch(`${base}${path}`, {
		...init,
		headers: { ...(await hostedAuth()), ...init?.headers },
	});
	if (!response.ok) throw new Error(`The directory answered ${response.status}`);
	return response;
}

/**
 * Publish this host's channels, then refresh what the directory knows. `onChange` runs after each
 * refresh. Failures keep the last answer, so an unreachable directory never hides channels.
 */
export function watch(
	self: () => Omit<Host, "seen">,
	channels: () => Promise<Listing[]>,
	onChange: () => void,
) {
	const controller = new AbortController();
	let pending = false;
	const sync = async () => {
		if (!url() || pending || controller.signal.aborted) return;
		pending = true;
		try {
			const host = self();
			await call(`/hosts/${encodeURIComponent(host.name)}`, {
				method: "PUT",
				body: JSON.stringify({ ...host, channels: await channels() }),
				signal: controller.signal,
			});
			known = await (await call("/", { signal: controller.signal })).json();
			synced = Date.now();
			error = undefined;
			log("debug", "directory.sync", {
				hosts: known.hosts.length,
				channels: known.channels.length,
			});
			onChange();
		} catch (cause) {
			if (controller.signal.aborted) return;
			error = (cause as Error).message;
			log("warn", "directory.failed", { url: url(), ...failure(cause) });
		} finally {
			pending = false;
		}
	};
	void sync();
	const interval = setInterval(() => void sync(), HEARTBEAT);
	return {
		sync,
		stop() {
			controller.abort();
			clearInterval(interval);
		},
	};
}
