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

let known: { hosts: Host[]; channels: Listing[] } = { hosts: [], channels: [] };
let synced: number | undefined;
let error: string | undefined;
/** The running host's watch, so a change made through it takes effect without waiting for a heartbeat. */
let active: { sync(): Promise<void>; changed(): void } | undefined;

/** A directory base URL without a trailing slash. */
export function canonical(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value.trim());
	} catch {
		throw new Error("Enter the directory's URL, starting with https://");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("Enter the directory's URL, starting with https://");
	}
	return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** Another directory's hosts and channels must not linger once this host leaves it. */
export function configure(value: string | undefined): Promise<void> | undefined {
	if (value) writeFileSync(config, JSON.stringify({ url: canonical(value) }));
	else rmSync(config, { force: true });
	known = { hosts: [], channels: [] };
	synced = undefined;
	error = undefined;
	active?.changed();
	return active?.sync();
}

/** Read the directory with `secret`, so a wrong URL or secret fails before either is saved. */
export async function check(base: string, secret: string): Promise<void> {
	let response: Response;
	try {
		response = await fetch(`${base}/`, {
			headers: { authorization: `Bearer ${secret}` },
			signal: AbortSignal.timeout(10_000),
			redirect: "error",
		});
	} catch {
		throw new Error(`Could not reach ${base}. Check the URL and your connection.`);
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(
			response.status === 401
				? "The directory rejected this secret. Ask whoever set it up for the team's secret."
				: `The directory answered HTTP ${response.status}. Check the URL.`,
		);
	}
	const body = await response.json().catch(() => undefined) as { hosts?: unknown } | undefined;
	if (!Array.isArray(body?.hosts)) throw new Error("This URL is not a team directory.");
}

export function status() {
	return { url: url(), synced, error };
}

/** The directory's last answer; empty until it first responds or without a directory. */
export function read() {
	return known;
}

async function call(base: string, path: string, init?: RequestInit): Promise<Response> {
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
		const base = url();
		if (!base || pending || controller.signal.aborted) return;
		pending = true;
		try {
			const host = self();
			await call(base, `/hosts/${encodeURIComponent(host.name)}`, {
				method: "PUT",
				body: JSON.stringify({ ...host, channels: await channels() }),
				signal: controller.signal,
			});
			const answer = await (await call(base, "/", { signal: controller.signal })).json();
			// The directory changed while this sync was under way; its answer belongs to the old one.
			if (url() !== base) return;
			known = answer;
			synced = Date.now();
			error = undefined;
			log("debug", "directory.sync", {
				hosts: known.hosts.length,
				channels: known.channels.length,
			});
			onChange();
		} catch (cause) {
			if (controller.signal.aborted || url() !== base) return;
			error = (cause as Error).message;
			log("warn", "directory.failed", { url: url(), ...failure(cause) });
		} finally {
			pending = false;
			if (url() !== base && !controller.signal.aborted) void sync();
		}
	};
	active = { sync, changed: onChange };
	void sync();
	const interval = setInterval(() => void sync(), HEARTBEAT);
	return {
		sync,
		stop() {
			active = undefined;
			controller.abort();
			clearInterval(interval);
		},
	};
}
