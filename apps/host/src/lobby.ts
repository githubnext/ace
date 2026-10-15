/**
 * Project lobbies (services/directory): one socket per project this host knows, carrying its
 * owner's presence there and everyone's back to the owner's app. Lobbies live in the directory's
 * Worker; without a directory, `ACE_SECRET`, or a Worker that has lobbies, each subscription
 * retries quietly with backoff and nothing else changes.
 */
import { type LobbyDown, type LobbyUp, PING, PONG, type Presence } from "@ace/directory/protocol";

import { hostedAuth } from "./client";
import * as directory from "./directory";
import { failure, log } from "./log";

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

type Lobby = {
	project: string;
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
	heard: number;
	wait: number;
	timer?: ReturnType<typeof setTimeout>;
	closed: boolean;
};

type Options = {
	host(): string;
	/** Presence or a lobby's liveness changed. */
	changed(): void;
};

const lobbies = new Map<string, Lobby>();
let here = new Map<string, Presence>();
let options: Options | undefined;

function send(lobby: Lobby, up: LobbyUp) {
	if (lobby.socket?.readyState === WebSocket.OPEN) lobby.socket.send(JSON.stringify(up));
}

function publish(lobby: Lobby, settled = false) {
	clearTimeout(lobby.away);
	const presence = here.get(lobby.project) || null;
	const frame = JSON.stringify(presence);
	if (frame === lobby.sent || lobby.socket?.readyState !== WebSocket.OPEN) return;
	const sent = lobby.sent && JSON.parse(lobby.sent) as Presence | null;
	if (presence?.away && !settled && sent && !sent.away) {
		lobby.away = setTimeout(() => publish(lobby, true), AWAY_AFTER);
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

/** Forget a socket now; its close event, if it ever arrives, then changes nothing. */
function drop(lobby: Lobby) {
	const socket = lobby.socket;
	clearTimeout(lobby.away);
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
		if (data !== PONG) receive(lobby, JSON.parse(String(data)) as LobbyDown);
	});
	socket.addEventListener("close", ({ code, reason }) => {
		if (lobby.socket !== socket) return;
		drop(lobby);
		retry(lobby, new Error(`The lobby closed (${code}${reason ? `: ${reason}` : ""})`));
	});
}

function receive(lobby: Lobby, down: LobbyDown) {
	switch (down.kind) {
		case "presence":
			lobby.people = down.people;
			return options?.changed();
		case "synced":
			lobby.seq = down.seq;
			lobby.live = true;
			lobby.wait = RETRY;
			log("info", "lobby.live", { project: lobby.project, seq: down.seq, resync: down.resync });
			return options?.changed();
		case "lifecycle":
			lobby.seq = down.seq;
	}
}

/**
 * Keep a subscription for each of `projects` and publish this host's owner's presence in each,
 * keyed by project ID; a project absent from `presence` means the owner is not here.
 */
export function update(projects: Set<string>, presence: Map<string, Presence>) {
	here = presence;
	// Before `watch`, the host does not know its tailnet name to say hello with.
	if (!options) return;
	const wanted = directory.url() ? projects : new Set<string>();
	for (const [project, lobby] of lobbies) {
		if (wanted.has(project)) continue;
		lobby.closed = true;
		clearTimeout(lobby.timer);
		drop(lobby);
		lobbies.delete(project);
	}
	for (const project of wanted) {
		const lobby = lobbies.get(project);
		if (lobby) {
			publish(lobby);
			continue;
		}
		const created: Lobby = {
			project,
			live: false,
			people: [],
			heard: 0,
			wait: RETRY,
			closed: false,
		};
		lobbies.set(project, created);
		void connect(created);
	}
}

/** Everyone here in each project whose lobby is live. */
export function presence(): Record<string, Presence[]> {
	const found: Record<string, Presence[]> = {};
	for (const lobby of lobbies.values()) if (lobby.live) found[lobby.project] = lobby.people;
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
		update(new Set(), new Map());
		options = undefined;
	};
}
