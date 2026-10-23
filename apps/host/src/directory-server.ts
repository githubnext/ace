/**
 * The team's directory served by this host on its tailnet listener, at `/directory`, with the
 * same API as services/directory. Tailscale names every caller, so it needs no team secret: a host
 * publishes only under its own machine name and login, and shares only as its owner.
 */
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { LobbyDown, LobbyUp, Presence, Share } from "@ace/directory/protocol";
import { PING, PONG } from "@ace/directory/protocol";

import * as catalog from "./catalog";
import { log } from "./log";

const file = join(catalog.home, "directory.sqlite");
/** Older lifecycle events are pruned; a host resuming from before them reads listings again. */
const RETAIN = 30 * 24 * 60 * 60_000;
/** A busy project still keeps a bounded log. */
const CAP = 2000;
const NAME = 256;
const HOST = /^\/hosts\/([A-Za-z0-9._-]{1,128})$/;
const LOBBY = /^\/lobbies\/([^/]{1,1024})$/;

/** Applied in order and counted in `user_version`. Never edit one that has shipped. */
const MIGRATIONS = [
	`CREATE TABLE hosts (name TEXT PRIMARY KEY, host TEXT NOT NULL);
	CREATE TABLE channels (id TEXT PRIMARY KEY, host TEXT NOT NULL, listing TEXT NOT NULL);
	CREATE INDEX channels_host ON channels (host);
	CREATE TABLE shares (
		project TEXT NOT NULL,
		person TEXT NOT NULL,
		shared_by TEXT NOT NULL,
		at INTEGER NOT NULL,
		PRIMARY KEY (project, person)
	);
	CREATE TABLE lobbies (project TEXT PRIMARY KEY, seq INTEGER NOT NULL);
	CREATE TABLE events (
		project TEXT NOT NULL,
		seq INTEGER NOT NULL,
		at INTEGER NOT NULL,
		event TEXT NOT NULL,
		PRIMARY KEY (project, seq)
	);
	CREATE INDEX events_at ON events (at);`,
];

/** Who Tailscale says is calling. */
export type Caller = { login: string; host: string };

/** A lobby socket's state; presence stays in memory, as in services/directory. */
export type Seat = {
	project: string;
	caller: Caller;
	host?: string;
	process?: string;
	presence: Presence | null;
};

type Socket = Bun.ServerWebSocket<{ lobby?: Seat }>;

type Publication = { login: string; github?: string; address?: string; channels: { id: string }[] };

let db: Database | undefined;
const seated = new Map<string, Set<Socket>>();

export function isServing(): boolean {
	return existsSync(file);
}

function open(): Database {
	if (db) return db;
	db = new Database(file, { create: true, strict: true });
	db.run("PRAGMA journal_mode = WAL");
	const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
	db.transaction(() => {
		for (const migration of MIGRATIONS.slice(version)) db!.run(migration);
		db!.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
	})();
	return db;
}

/** Start serving; teammates' hosts find it through this host's hello. */
export function create(): void {
	open();
	log("info", "directory.serve", { file });
}

/** Stop serving. Hosts republish everything but shares, which go with it. */
export function remove(): void {
	for (const sockets of seated.values()) for (const socket of sockets) socket.close(1001, "gone");
	seated.clear();
	db?.close();
	db = undefined;
	for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
	log("info", "directory.removed", {});
}

/** The project shares stopping deletes. */
export function shares(): Share[] {
	if (!isServing()) return [];
	return open().query<Share, []>('SELECT project, person, shared_by AS "by", at FROM shares').all();
}

/**
 * Requests under `/directory`, with `path` the rest; `members` runs when a host publishes for the
 * first time or leaves, so this host's own views follow at once.
 */
export async function handle(
	path: string,
	request: Request,
	caller: Caller,
	members: () => void,
): Promise<Response> {
	if (!isServing()) return new Response("This host serves no directory", { status: 404 });
	const sql = open();
	if (path === "/" && request.method === "GET") return Response.json(read(sql));
	const host = HOST.exec(path)?.[1];
	if (host && request.method === "PUT") {
		const publication = await request.json() as Publication;
		// Tailscale vouches for the machine and its owner, so neither can be claimed for another.
		if (host !== caller.host || publication.login !== caller.login) {
			return new Response("Hosts publish only as themselves", { status: 403 });
		}
		const known = sql.query("SELECT 1 FROM hosts WHERE name = ?").get(host);
		publish(sql, host, publication);
		if (!known) members();
		return new Response(null, { status: 204 });
	}
	if (host && request.method === "DELETE") {
		if (host !== caller.host) {
			return new Response("Hosts leave only as themselves", { status: 403 });
		}
		sql.transaction(() => {
			sql.run("DELETE FROM hosts WHERE name = ?", [host]);
			sql.run("DELETE FROM channels WHERE host = ?", [host]);
		})();
		members();
		return new Response(null, { status: 204 });
	}
	if (path === "/shares" && request.method === "POST") {
		const { project, person, by, shared } = await request.json() as Omit<Share, "at"> & {
			shared: boolean;
		};
		if (by !== caller.login) return new Response("Share only as yourself", { status: 403 });
		if (shared) {
			sql.run("INSERT OR REPLACE INTO shares VALUES (?, ?, ?, ?)", [
				project,
				person,
				by,
				Date.now(),
			]);
		} else {
			sql.run("DELETE FROM shares WHERE project = ? AND person = ?", [project, person]);
		}
		return new Response(null, { status: 204 });
	}
	return new Response("Not found", { status: 404 });
}

/** The project a lobby upgrade asks for, or undefined when `path` isn't a lobby. */
export function lobbyOf(path: string): string | undefined {
	const project = LOBBY.exec(path)?.[1];
	if (!project) return;
	try {
		return decodeURIComponent(project);
	} catch {
		return;
	}
}

function read(sql: Database) {
	return {
		hosts: sql.query<{ host: string }, []>("SELECT host FROM hosts").all().map((row) =>
			JSON.parse(row.host)
		),
		channels: sql.query<{ listing: string }, []>("SELECT listing FROM channels").all().map((row) =>
			JSON.parse(row.listing)
		),
		shares: shares(),
	};
}

/** Each publication replaces the host's whole channel set. */
function publish(sql: Database, name: string, { channels, ...rest }: Publication) {
	sql.transaction(() => {
		sql.run("INSERT OR REPLACE INTO hosts VALUES (?, ?)", [
			name,
			JSON.stringify({ ...rest, name, seen: Date.now() }),
		]);
		sql.run("DELETE FROM channels WHERE host = ?", [name]);
		const insert = sql.prepare("INSERT OR REPLACE INTO channels VALUES (?, ?, ?)");
		for (const channel of channels) insert.run(channel.id, name, JSON.stringify(channel));
	})();
}

export function opened(socket: Socket) {
	const { project } = socket.data.lobby!;
	let sockets = seated.get(project);
	if (!sockets) seated.set(project, sockets = new Set());
	sockets.add(socket);
}

export function received(socket: Socket, raw: string | Buffer) {
	const seat = socket.data.lobby!;
	const text = String(raw);
	if (text === PING) return void socket.send(PONG);
	const up = JSON.parse(text) as LobbyUp;
	if (up.op === "hello") {
		if (up.host.length > NAME || up.process.length > NAME) {
			return socket.close(1008, "names too long");
		}
		if (up.host !== seat.caller.host) return socket.close(1008, "hosts join only as themselves");
		seat.host = up.host;
		seat.process = up.process;
		// A reconnect can arrive before the same process's previous socket closes.
		for (const old of seated.get(seat.project) || []) {
			const other = old.data.lobby!;
			if (old !== socket && other.host === up.host && other.process === up.process) {
				old.close(1000, "replaced");
			}
		}
		replay(socket, seat.project, up.since);
		return send(socket, { kind: "presence", people: people(seat.project) });
	}
	if (!seat.host) return socket.close(1008, "hello first");
	if (up.op === "presence") {
		seat.presence = up.presence && { ...up.presence, host: seat.host };
		return broadcast(seat.project, { kind: "presence", people: people(seat.project) });
	}
	const event = { ...up.event, host: seat.host };
	const sql = open();
	const now = Date.now();
	const seq = sql.transaction(() => {
		const next = latest(sql, seat.project) + 1;
		sql.run("INSERT OR REPLACE INTO lobbies VALUES (?, ?)", [seat.project, next]);
		sql.run("INSERT INTO events VALUES (?, ?, ?, ?)", [
			seat.project,
			next,
			now,
			JSON.stringify(event),
		]);
		sql.run("DELETE FROM events WHERE project = ? AND (at < ? OR seq <= ?)", [
			seat.project,
			now - RETAIN,
			next - CAP,
		]);
		return next;
	})();
	broadcast(seat.project, { kind: "lifecycle", seq, event });
}

export function left(socket: Socket) {
	const { project, presence } = socket.data.lobby!;
	const sockets = seated.get(project);
	sockets?.delete(socket);
	if (!sockets?.size) seated.delete(project);
	if (presence) broadcast(project, { kind: "presence", people: people(project) });
}

function latest(sql: Database, project: string): number {
	return sql.query<{ seq: number }, [string]>("SELECT seq FROM lobbies WHERE project = ?")
		.get(project)?.seq || 0;
}

function people(project: string): Presence[] {
	return [...seated.get(project) || []].flatMap((socket) => {
		const { presence } = socket.data.lobby!;
		return presence ? [presence] : [];
	});
}

/** Sends the events after `since`, or asks the host to read listings again when they are gone. */
function replay(socket: Socket, project: string, since: number | undefined) {
	const sql = open();
	const last = latest(sql, project);
	const oldest = sql.query<{ seq: number | null }, [string]>(
		"SELECT min(seq) AS seq FROM events WHERE project = ?",
	).get(project)!.seq;
	const resync = since === undefined || since > last || since < (oldest || last + 1) - 1;
	if (!resync) {
		const rows = sql.query<{ seq: number; event: string }, [string, number]>(
			"SELECT seq, event FROM events WHERE project = ? AND seq > ? ORDER BY seq",
		).all(project, since);
		for (const row of rows) {
			send(socket, { kind: "lifecycle", seq: row.seq, event: JSON.parse(row.event) });
		}
	}
	send(socket, { kind: "synced", seq: last, resync });
}

function send(socket: Socket, down: LobbyDown) {
	socket.send(JSON.stringify(down));
}

function broadcast(project: string, down: LobbyDown) {
	const frame = JSON.stringify(down);
	for (const socket of seated.get(project) || []) if (socket.data.lobby!.host) socket.send(frame);
}
