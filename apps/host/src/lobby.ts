/**
 * Project lobbies (services/directory): one socket per project this host knows, carrying its
 * owner's presence and its channels' lifecycle there, and everyone's back. Lobbies live in the
 * directory's Worker; without a directory, `ACE_SECRET`, or a Worker that has lobbies, each
 * subscription retries quietly with backoff and the directory's 30 s poll continues.
 */
import {
	type Lifecycle,
	type LobbyDown,
	type LobbyUp,
	PING,
	PONG,
	type Presence,
} from "@ace/directory/protocol";

import { hostedAuth } from "./client";
import * as directory from "./directory";
import { failure, log } from "./log";
import { channelProject, type Listing } from "./protocol";

type Event = Omit<Lifecycle<Listing>, "host">;

const PING_EVERY = 30_000;
/** Two missed pongs mean the socket died without closing, as when a laptop sleeps. */
const SILENT = 2 * PING_EVERY + 5_000;
const RETRY = 5_000;
/** A Worker deployed before lobbies answers 404 to every attempt, so retries slow to this. */
const RETRY_MAX = 10 * 60_000;
/** Switching between Ace windows blurs one before focusing the next; only a lasting blur is away. */
const AWAY_AFTER = 3_000;
/** Lets the lobby replace this process's stale socket without evicting another Ace on this machine. */
const PROCESS = crypto.randomUUID();
/** A replay can deliver thousands of events; listings are rebuilt once per burst, not per event. */
const REFRESH_AFTER = 100;

type Lobby = {
	project: string;
	/** The owner's app lists the project. An unwanted lobby stays only to deliver `queued`. */
	wanted: boolean;
	socket?: WebSocket;
	/** The lobby has replayed what this host missed, so its pushes can be trusted. */
	live: boolean;
	/** The newest lifecycle seq applied, to resume from after reconnecting. */
	seq?: number;
	people: Presence[];
	/** The presence last sent, so unchanged updates are skipped. */
	sent?: string;
	/** A pending report that the owner went away. */
	away?: ReturnType<typeof setTimeout>;
	/**
	 * This host's events the lobby has not echoed back, latest per channel since each carries the
	 * whole listing. A socket can die unnoticed for up to `SILENT`, so they are resent once live.
	 */
	queued: Map<string, Event>;
	heard: number;
	wait: number;
	timer?: ReturnType<typeof setTimeout>;
	closed: boolean;
};

type Options = {
	host(): string;
	/** Presence or a lobby's liveness changed. */
	changed(): void;
	/** Other hosts' lifecycle events changed the directory's listings. */
	listed(): void;
	/** The lobby lost events this host missed, so listings must be read again. */
	resync(): void;
};

const lobbies = new Map<string, Lobby>();
let here = new Map<string, Presence>();
let options: Options | undefined;
let refresh: ReturnType<typeof setTimeout> | undefined;

function send(lobby: Lobby, up: LobbyUp<Listing>) {
	if (lobby.socket?.readyState === WebSocket.OPEN) lobby.socket.send(JSON.stringify(up));
}

function publish(lobby: Lobby, settled = false) {
	const presence = here.get(lobby.project) || null;
	if (settled || !presence?.away) settle(lobby);
	const frame = JSON.stringify(presence);
	if (frame === lobby.sent || lobby.socket?.readyState !== WebSocket.OPEN) return;
	const sent = lobby.sent && JSON.parse(lobby.sent) as Presence | null;
	if (presence?.away && !settled && sent && !sent.away) {
		// Listings publish often; restarting the wait on each would postpone away indefinitely.
		lobby.away ??= setTimeout(() => publish(lobby, true), AWAY_AFTER);
		return;
	}
	lobby.sent = frame;
	send(lobby, { op: "presence", presence });
}

function retry(lobby: Lobby, cause?: unknown) {
	if (lobby.closed) return;
	log("debug", "lobby.retry", {
		project: lobby.project,
		wait: lobby.wait,
		...(cause ? failure(cause) : {}),
	});
	lobby.timer = setTimeout(() => void connect(lobby), lobby.wait);
	lobby.wait = Math.min(lobby.wait * 2, RETRY_MAX);
}

function settle(lobby: Lobby) {
	clearTimeout(lobby.away);
	lobby.away = undefined;
}

/** Forget a socket now; its close event, if it ever arrives, then changes nothing. */
function drop(lobby: Lobby) {
	const socket = lobby.socket;
	settle(lobby);
	lobby.socket = undefined;
	lobby.sent = undefined;
	const live = lobby.live;
	lobby.live = false;
	lobby.people = [];
	socket?.close();
	if (live) {
		log("info", "lobby.drop", { project: lobby.project });
		options?.changed();
	}
}

function close(lobby: Lobby) {
	lobby.closed = true;
	clearTimeout(lobby.timer);
	drop(lobby);
	lobbies.delete(lobby.project);
}

function open(project: string, wanted: boolean): Lobby {
	const lobby: Lobby = {
		project,
		wanted,
		live: false,
		people: [],
		queued: new Map(),
		heard: 0,
		wait: RETRY,
		closed: false,
	};
	lobbies.set(project, lobby);
	void connect(lobby);
	return lobby;
}

async function connect(lobby: Lobby) {
	lobby.timer = undefined;
	const base = directory.url();
	if (lobby.closed || !base) return;
	let socket: WebSocket;
	try {
		socket = new WebSocket(
			`${base.replace(/^http/, "ws")}/lobbies/${encodeURIComponent(lobby.project)}`,
			{ headers: await hostedAuth() } as unknown as string[],
		);
	} catch (error) {
		return retry(lobby, error);
	}
	if (lobby.closed) return socket.close();
	lobby.socket = socket;
	socket.addEventListener("open", () => {
		lobby.heard = Date.now();
		send(lobby, { op: "hello", host: options!.host(), process: PROCESS, since: lobby.seq });
		publish(lobby);
	});
	socket.addEventListener("message", ({ data }) => {
		lobby.heard = Date.now();
		if (data !== PONG) receive(lobby, JSON.parse(String(data)) as LobbyDown<Listing>);
	});
	socket.addEventListener("close", ({ code, reason }) => {
		if (lobby.socket !== socket) return;
		drop(lobby);
		retry(lobby, new Error(`The lobby closed (${code}${reason ? `: ${reason}` : ""})`));
	});
}

function listed() {
	refresh ??= setTimeout(() => {
		refresh = undefined;
		options?.listed();
	}, REFRESH_AFTER);
}

function receive(lobby: Lobby, down: LobbyDown<Listing>) {
	switch (down.kind) {
		case "presence":
			lobby.people = down.people;
			return options?.changed();
		case "synced":
			lobby.seq = down.seq;
			lobby.live = true;
			lobby.wait = RETRY;
			log("info", "lobby.live", { project: lobby.project, seq: down.seq, resync: down.resync });
			for (const event of lobby.queued.values()) send(lobby, { op: "lifecycle", event });
			if (down.resync) options?.resync();
			return options?.changed();
		case "lifecycle": {
			lobby.seq = down.seq;
			const { event } = down;
			if (event.host !== options?.host()) {
				directory.apply(event);
				return listed();
			}
			if (lobby.queued.get(event.channel)?.at === event.at) lobby.queued.delete(event.channel);
			if (!lobby.wanted && !lobby.queued.size) close(lobby);
		}
	}
}

function emit(project: string, event: Event) {
	// Publishing can outrun the subscription for a new project, or follow its last channel's deletion.
	const lobby = lobbies.get(project) || open(project, false);
	lobby.queued.set(event.channel, event);
	if (lobby.live) send(lobby, { op: "lifecycle", event });
}

/**
 * Tell each project's lobby what changed in this host's own channels between two publications to
 * the directory. Hosts send them only after publishing, so a teammate who reads the directory on
 * receipt agrees with the event. Activity alone (`active`, `busy`, running or idle) sends none;
 * teammates see it from peers or the directory's next read.
 */
export function published(before: Listing[], after: Listing[]) {
	const at = Date.now();
	const previous = new Map(before.map((listing) => [listing.id, listing]));
	for (const listing of after) {
		const old = previous.get(listing.id);
		previous.delete(listing.id);
		const archived = listing.state === "archived";
		const kind = !old
			? "created"
			: (old.state === "archived") !== archived
			? archived ? "archived" : "resumed"
			: old.hosted !== listing.hosted
			? "moved"
			: old.name !== listing.name
			? "renamed"
			: old.summary !== listing.summary
			? "summarized"
			: old.ran !== listing.ran
			? "ran"
			: undefined;
		if (kind) emit(channelProject(listing), { channel: listing.id, kind, at, listing });
	}
	for (const old of previous.values()) {
		emit(channelProject(old), { channel: old.id, kind: "deleted", at });
	}
	for (const lobby of lobbies.values()) if (!lobby.wanted && !lobby.queued.size) close(lobby);
}

/** Every project this host subscribes to has a live lobby, so the lobbies push their changes. */
export function isCovered(): boolean {
	const wanted = [...lobbies.values()].filter((lobby) => lobby.wanted);
	return wanted.length > 0 && wanted.every((lobby) => lobby.live);
}

/**
 * Keep a subscription for each of `projects` and publish this host's owner's presence in each,
 * keyed by project ID; a project absent from `presence` means the owner is not here. A lobby no
 * longer wanted stays until the next publication, which may send its project's deletions.
 */
export function update(projects: Set<string>, presence: Map<string, Presence>) {
	here = presence;
	// Before `watch`, the host does not know its tailnet name to say hello with.
	if (!options) return;
	const wanted = directory.url() ? projects : new Set<string>();
	for (const lobby of lobbies.values()) {
		if (!directory.url()) close(lobby);
		else lobby.wanted = wanted.has(lobby.project);
	}
	for (const project of wanted) {
		const lobby = lobbies.get(project);
		if (lobby) publish(lobby);
		else open(project, true);
	}
}

/** Everyone here in each project whose lobby is live. */
export function presence(): Record<string, Presence[]> {
	const found: Record<string, Presence[]> = {};
	for (const lobby of lobbies.values()) {
		if (lobby.wanted && lobby.live) found[lobby.project] = lobby.people;
	}
	return found;
}

export function watch(given: Options): () => void {
	options = given;
	const interval = setInterval(() => {
		const now = Date.now();
		for (const lobby of lobbies.values()) {
			if (lobby.socket?.readyState !== WebSocket.OPEN) continue;
			if (now - lobby.heard < SILENT) {
				lobby.socket.send(PING);
				continue;
			}
			log("warn", "lobby.silent", { project: lobby.project });
			drop(lobby);
			retry(lobby);
		}
	}, PING_EVERY);
	return () => {
		clearInterval(interval);
		clearTimeout(refresh);
		for (const lobby of lobbies.values()) close(lobby);
		options = undefined;
	};
}
