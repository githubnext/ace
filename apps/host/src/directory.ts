/**
 * The team's directory (services/directory): this host publishes its channels there and reads
 * everyone else's, so a channel stays listed while its host is asleep.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Lifecycle } from "@ace/directory/protocol";

import * as catalog from "./catalog";
import { hostedAuth } from "./client";
import { refusal } from "./http";
import { failure, log } from "./log";
import type { Listing } from "./protocol";

const HEARTBEAT = 30_000;
/** While every known project's lobby is live, polling only discovers new projects and hosts. */
const DISCOVERY = 5 * 60_000;

/** `github` is the owner's GitHub login, so clients can show avatars for their messages. */
type Host = { name: string; login: string; github?: string; address?: string; seen: number };

const config = join(catalog.home, "directory.json");

export function url(): string | undefined {
	if (process.env.ACE_DIRECTORY) return process.env.ACE_DIRECTORY;
	if (existsSync(config)) return JSON.parse(readFileSync(config, "utf8")).url;
}

let known: { hosts: Host[]; channels: Listing[] } = { hosts: [], channels: [] };
let synced: number | undefined;
/** The last sync's failure, kept until a sync succeeds so Settings can say what is wrong and since when. */
let error: string | undefined;
let failed: number | undefined;
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
	failed = undefined;
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
	if (response.status === 401) {
		await response.body?.cancel();
		throw new Error(
			"The directory rejected this secret. Ask whoever set it up for the team's secret.",
		);
	}
	if (!response.ok) {
		const reason = await refusal(response, "The directory");
		throw new Error(response.status < 500 ? `${reason} Check the URL.` : reason);
	}
	const body = await response.json().catch(() => undefined) as { hosts?: unknown } | undefined;
	if (!Array.isArray(body?.hosts)) throw new Error("This URL is not a team directory.");
}
/** Lifecycle events applied while a read is in flight; that read may predate them. */
let reading: Lifecycle<Listing>[] | undefined;

export function status() {
	return { url: url(), synced, error, failed };
}

/** Sync now, or join the sync under way; nothing without a running host. */
export function sync(): Promise<void> {
	return active?.sync() ?? Promise.resolve();
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

async function call(
	base: string,
	path: string,
	signal: AbortSignal,
	init?: RequestInit,
): Promise<Response> {
	const headers = { ...(await hostedAuth()), ...init?.headers };
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
		throw new Error(`Could not reach ${base}. Check the URL and your connection.`, { cause });
	}
	if (response.status === 401) {
		await response.body?.cancel();
		throw new Error(
			"The directory rejected this host's ACE_SECRET. Ask whoever set it up for the team's secret.",
		);
	}
	if (!response.ok) {
		const reason = await refusal(response, "The directory");
		throw new Error(response.status < 500 ? `${reason} Check the URL.` : reason);
	}
	return response;
}

type Options = {
	self(): Omit<Host, "seen">;
	channels(): Promise<Listing[]>;
	/** After each refresh. */
	changed(): void;
	/** After each publish; `before` is this process's previous publication, if any. */
	published(before: Listing[] | undefined, after: Listing[]): void;
	/** Every project this host knows has a live lobby pushing its changes. */
	covered(): boolean;
};

/**
 * Publish this host's channels, then refresh what the directory knows. Failures keep the last
 * answer, so an unreachable directory never hides channels.
 */
export function watch({ self, channels, changed, published, covered }: Options) {
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
			const answer: typeof known = await (await call(base, "/", controller.signal)).json();
			// The directory changed while this sync was under way; its answer belongs to the old one.
			if (url() !== base) return;
			for (const event of reading) answer.channels = patch(answer.channels, event);
			known = answer;
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
	active = { sync: join, changed };
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
