/**
 * The team's directory, served by a host on the tailnet (directory-server.ts) or deployed from
 * services/directory: this host publishes its channels there and reads everyone else's, so a
 * channel stays listed while its host is offline.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Lifecycle, Share } from "@ace/directory/protocol";

import * as catalog from "./catalog";
import { directoryAuth, serviceAuth } from "./client";
import { refusal, rejection } from "./http";
import { failure, log } from "./log";
import type { Listing } from "./protocol";

const HEARTBEAT = 30_000;
/** While every known project's lobby is live, polling only discovers new projects and hosts. */
const DISCOVERY = 5 * 60_000;

/** `github` is the owner's GitHub login, so clients can show avatars for their messages. */
type Host = { name: string; login: string; github?: string; address?: string; seen: number };

const config = join(catalog.home, "directory.json");

/** `app`, `hosted`, and `compute` are the team's web app and services, set where the directory is deployed. */
type Services = { app?: string; hosted?: string; compute?: string };
type Known = Services & { hosts: Host[]; channels: Listing[]; shares: Share[] };

/** The joined directory's URL and the services it last named; no URL after leaving one. */
type Saved = Services & { url?: string };

function saved(): Saved | undefined {
	if (existsSync(config)) return JSON.parse(readFileSync(config, "utf8"));
}

export function url(): string | undefined {
	return process.env.ACE_DIRECTORY || saved()?.url;
}

/** The services survive a restart so cloud options don't wait for the first sync, or vanish offline. */
function remembered(): Known {
	const value = saved();
	const base = { hosts: [], channels: [], shares: [] };
	if (!value || value.url !== url()) return base;
	return { ...base, app: value.app, hosted: value.hosted, compute: value.compute };
}

/** Only the joined directory's file records its services; ACE_DIRECTORY alone writes nothing. */
function remember(base: string, { app, hosted, compute }: Services) {
	const value = saved();
	if (value?.url !== base) return;
	if (value.app === app && value.hosted === hosted && value.compute === compute) return;
	writeFileSync(config, JSON.stringify({ url: base, app, hosted, compute }));
}

let known: Known = remembered();
let synced: number | undefined;
/** The last sync's failure, kept until a sync succeeds so Settings can say what is wrong and since when. */
let error: string | undefined;
let failed: number | undefined;
/** The running host's watch, so a change made through it takes effect without waiting for a heartbeat. */
let active:
	| {
		sync(): Promise<void>;
		again(): Promise<void>;
		changed(): void;
		chose(): void;
		leave(base: string): Promise<void>;
	}
	| undefined;

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

/**
 * Another directory's hosts and channels must not linger once this host leaves it. Leaving keeps
 * an empty file, so a host that left never joins a peer's directory on its own again.
 */
export function configure(value: string | undefined): Promise<void> | undefined {
	const before = url();
	const after = value && canonical(value);
	writeFileSync(config, JSON.stringify(after ? { url: after } : {}));
	// Teammates' views, including the serving Mac's, drop this host only when it says it left.
	if (before && before !== after) void active?.leave(before);
	known = { hosts: [], channels: [], shares: [] };
	synced = undefined;
	error = undefined;
	failed = undefined;
	active?.chose();
	active?.changed();
	return active?.sync();
}

/**
 * Read the directory, with `secret` for a deployed one, so a wrong URL or secret fails before
 * either is saved.
 */
export async function check(base: string, secret?: string): Promise<void> {
	const headers = secret ? await serviceAuth(secret) : {};
	let response: Response;
	try {
		response = await fetch(`${base}/`, {
			headers,
			signal: AbortSignal.timeout(10_000),
			redirect: "error",
		});
	} catch {
		throw new Error(`Could not reach ${base}. Check the URL and your connection.`);
	}
	if (response.status === 401) throw new Error(await rejection(response, "The directory"));
	if (!response.ok) {
		const reason = await refusal(response, "The directory");
		throw new Error(response.status < 500 ? `${reason} Check the URL.` : reason);
	}
	const body = await response.json().catch(() => undefined) as { hosts?: unknown } | undefined;
	if (!Array.isArray(body?.hosts)) throw new Error("This URL is not a team directory.");
}
/** This host joined a directory or left one, so it doesn't join a peer's on its own. */
export function isChosen(): boolean {
	return existsSync(config) || !!process.env.ACE_DIRECTORY;
}

/** The directory each peer's host names, so a host without one can offer to join it. */
const offers = new Map<string, string>();

export function offer(peer: string, value: string | undefined): void {
	if (value) offers.set(peer, value);
	else offers.delete(peer);
}

/** A directory a peer's host names while this host has none, as after leaving one. */
export function offered(): { url: string; host: string } | undefined {
	if (url()) return;
	const [host, value] = offers.entries().next().value ?? [];
	return host && value ? { url: value, host } : undefined;
}

/**
 * When each URL a peer named last failed without a secret, so discovery doesn't ask every 15
 * seconds; its host may only be offline, so it's asked again later.
 */
const refused = new Map<string, number>();
const RETRY_ADOPT = 10 * 60_000;

/**
 * Join the directory a peer's host names, when this host never chose one: a directory a host
 * serves admits everyone on the tailnet, so a team needs no invite. A deployed directory refuses
 * hosts without its secret and is left to Settings.
 */
export async function adopt(value: string): Promise<void> {
	if (isChosen() || Date.now() - (refused.get(value) || 0) < RETRY_ADOPT) return;
	const base = canonical(value);
	try {
		await check(base);
	} catch (error) {
		refused.set(value, Date.now());
		log("info", "directory.adopt.refused", { url: base, ...failure(error) });
		return;
	}
	// Another peer's hello may have joined one while this check ran.
	if (isChosen()) return;
	log("info", "directory.adopted", { url: base });
	await configure(base);
}

/** Lifecycle events applied while a read is in flight; that read may predate them. */
let reading: Lifecycle<Listing>[] | undefined;

/** `server` is the teammate's Mac serving a tailnet directory, by its tailnet name. */
export function status() {
	const base = url();
	return { url: base, server: base && server(base)?.name, synced, error, failed };
}

/** Sync now, or join the sync under way; nothing without a running host. */
export function sync(): Promise<void> {
	return active?.sync() ?? Promise.resolve();
}

/** Read the directory again even if a sync is under way, which may have read it before a change. */
export function refresh(): Promise<void> {
	return active?.again() ?? Promise.resolve();
}

/** The directory's last answer; empty until it first responds or without a directory. */
export function read() {
	return known;
}

function patch(channels: Listing[], event: Lifecycle<Listing>): Listing[] {
	const kept = channels.filter((channel) => channel.id !== event.channel);
	return event.listing ? [...kept, event.listing] : kept;
}

/**
 * A lobby pushed a channel's change, which its host sent only after publishing it here, so the
 * next read agrees; until then the event stands in for it.
 */
export function apply(event: Lifecycle<Listing>) {
	reading?.push(event);
	known = { ...known, channels: patch(known.channels, event) };
}

/** Shares are the directory's to keep, so a change waits for it and the next sync reads it back. */
export async function share(share: Omit<Share, "at">, shared: boolean): Promise<void> {
	const base = url();
	if (!base) throw new Error("Join a team directory to share projects.");
	await call(base, "/shares", AbortSignal.timeout(10_000), {
		method: "POST",
		body: JSON.stringify({ ...share, shared }),
	});
	await refresh();
}

async function call(
	base: string,
	path: string,
	signal: AbortSignal,
	init?: RequestInit,
): Promise<Response> {
	const headers = { ...(await directoryAuth()), ...init?.headers };
	let response: Response;
	try {
		// A directory that never answers must still fail the sync, or Settings waits forever.
		response = await fetch(`${base}${path}`, {
			...init,
			headers,
			signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
		});
	} catch (cause) {
		if (signal.aborted) throw cause;
		const host = server(base);
		throw new Error(
			host
				? `${host.name}, which serves the directory, is offline. Channels stay listed as they were.`
				: `Could not reach ${base}. Check the URL and your connection.`,
			{ cause },
		);
	}
	if (response.status === 401) throw new Error(await rejection(response, "The directory"));
	if (!response.ok) {
		const host = server(base);
		if (host && response.status === 404) {
			throw new Error(
				`${host.name} stopped serving the directory. Channels stay listed as they were.`,
			);
		}
		const reason = await refusal(response, "The directory");
		throw new Error(response.status < 500 ? `${reason} Check the URL.` : reason);
	}
	return response;
}

/**
 * The teammate's host serving a tailnet directory, found by the address it publishes, so a failure
 * names their Mac rather than blaming this one's connection. A deployed directory has none.
 */
function server(base: string): Host | undefined {
	const address = new URL(base).hostname.replace(/^\[|\]$/g, "");
	return known.hosts.find((host) => host.address === address);
}

type Options = {
	self(): Omit<Host, "seen">;
	channels(): Promise<Listing[]>;
	/** After each refresh. */
	changed(): void;
	/** After joining, changing, or leaving the directory, by any route: the app, the CLI, or a peer's hello. */
	chose(): void;
	/** After each publish; `before` is this process's previous publication, if any. */
	published(before: Listing[] | undefined, after: Listing[]): void;
	/** Every project this host knows has a live lobby pushing its changes. */
	covered(): boolean;
};

/**
 * Publish this host's channels, then refresh what the directory knows. Failures keep the last
 * answer, so an unreachable directory never hides channels.
 */
export function watch({ self, channels, changed, chose, published, covered }: Options) {
	const controller = new AbortController();
	let running: { base: string; done: Promise<void>; again?: Promise<void> } | undefined;
	let before: Listing[] | undefined;
	const attempt = async (base: string) => {
		try {
			const host = self();
			const after = await channels();
			await call(base, `/hosts/${encodeURIComponent(host.name)}`, controller.signal, {
				method: "PUT",
				body: JSON.stringify({ ...host, channels: after }),
			});
			published(before, after);
			before = after;
			reading = [];
			const answer: Known = await (await call(base, "/", controller.signal)).json();
			// The directory changed while this sync was under way; its answer belongs to the old one.
			if (url() !== base) return;
			for (const event of reading) answer.channels = patch(answer.channels, event);
			// Directories deployed before project access keep no shares.
			answer.shares ||= [];
			known = answer;
			remember(base, answer);
			synced = Date.now();
			error = undefined;
			failed = undefined;
			log("debug", "directory.sync", {
				hosts: known.hosts.length,
				channels: known.channels.length,
			});
			changed();
		} catch (cause) {
			if (controller.signal.aborted || url() !== base) return;
			error = (cause as Error).message;
			failed = Date.now();
			log("warn", "directory.failed", { url: base, ...failure(cause) });
		} finally {
			reading = undefined;
		}
	};
	const join = (): Promise<void> => {
		const base = url();
		if (!base || controller.signal.aborted) return Promise.resolve();
		if (running?.base === base) return running.done;
		// A sync for the old URL may wait on a keychain prompt; don't hold a directory change on it.
		if (running) {
			void running.done.then(join);
			return Promise.resolve();
		}
		const done = attempt(base).finally(() => {
			running = undefined;
		});
		running = { base, done };
		return done;
	};
	/** For a change: the sync under way may have read channels before it, so one more follows. */
	const sync = (): Promise<void> => {
		if (!running || running.base !== url()) return join();
		return running.again ??= running.done.then(join);
	};
	const leave = async (base: string) => {
		// A publish under way would list this host again after it left.
		if (running?.base === base) await running.done;
		try {
			await call(base, `/hosts/${encodeURIComponent(self().name)}`, controller.signal, {
				method: "DELETE",
			});
			log("info", "directory.left", { url: base });
		} catch (cause) {
			log("warn", "directory.leave.failed", { url: base, ...failure(cause) });
		}
	};
	active = { sync: join, again: sync, changed, chose, leave };
	void join();
	const interval = setInterval(() => {
		// A failed publish keeps retrying every heartbeat; lobbies only carry what was published.
		if (covered() && !error && Date.now() - (synced || 0) < DISCOVERY) return;
		void join();
	}, HEARTBEAT);
	return {
		sync,
		stop() {
			active = undefined;
			controller.abort();
			clearInterval(interval);
		},
	};
}
