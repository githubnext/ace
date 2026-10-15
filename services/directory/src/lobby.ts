import { DurableObject } from "cloudflare:workers";

import type { Lifecycle, LobbyDown, LobbyUp, Presence } from "./protocol";
import { PING, PONG } from "./protocol";

/** Older lifecycle events are pruned; a host resuming from before them reads listings again. */
const RETAIN = 30 * 24 * 60 * 60_000;
/** A busy project still keeps a bounded log. */
const CAP = 2000;
/** Hosts ping every 30 s; a socket silent this long belongs to a host that slept without closing it. */
const SILENT = 90_000;
const SWEEP = 60_000;

/**
 * Applied in order and counted in the `version` key, since Durable Object SQLite refuses
 * `PRAGMA user_version`. Never edit one that has shipped.
 */
const MIGRATIONS = [
	`CREATE TABLE events (
		seq INTEGER PRIMARY KEY,
		at INTEGER NOT NULL,
		event TEXT NOT NULL
	);
	CREATE INDEX events_at ON events (at);`,
];

/** Presence lives on the socket, so hibernation keeps it and it never reaches storage. */
type Attachment = { host?: string; seen: number; presence: Presence | null };

function log(level: "info" | "warn", event: string, fields: Record<string, unknown>) {
	const line = { level, event, ...fields };
	if (level === "warn") console.warn(line);
	else console.log(line);
}

/**
 * One project's presence and ordered channel lifecycle. Hosts are its only clients. Lifecycle
 * events are a 30-day resume buffer over listings, which stay authoritative; presence is in memory.
 */
export class Lobby extends DurableObject {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
		const version = ctx.storage.kv.get<number>("version") || 0;
		if (version >= MIGRATIONS.length) return;
		ctx.storage.transactionSync(() => {
			for (const migration of MIGRATIONS.slice(version)) ctx.storage.sql.exec(migration);
			ctx.storage.kv.put("version", MIGRATIONS.length);
		});
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade") !== "websocket") {
			return new Response("Lobbies are WebSockets", { status: 426 });
		}
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ seen: Date.now(), presence: null } satisfies Attachment);
		if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + SWEEP);
		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
		const attachment = socket.deserializeAttachment() as Attachment;
		attachment.seen = Date.now();
		const up = JSON.parse(message as string) as LobbyUp;
		if (up.op === "hello") {
			attachment.host = up.host;
			socket.serializeAttachment(attachment);
			// A reconnect can arrive before the host's previous socket closes.
			for (const old of this.#open()) {
				const other = old.deserializeAttachment() as Attachment;
				if (old !== socket && other.host === up.host) this.#close(old, "replaced");
			}
			this.#replay(socket, up.since);
			return this.#send(socket, { kind: "presence", people: this.#people() });
		}
		if (!attachment.host) return socket.close(1008, "hello first");
		if (up.op === "presence") {
			attachment.presence = up.presence && { ...up.presence, host: attachment.host };
			socket.serializeAttachment(attachment);
			return this.#broadcast({ kind: "presence", people: this.#people() });
		}
		socket.serializeAttachment(attachment);
		const event: Lifecycle = { ...up.event, host: attachment.host };
		// Kept apart from the rows, so pruning every event never reuses a seq a host resumes from.
		const seq = this.#latest() + 1;
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.kv.put("seq", seq);
			this.ctx.storage.sql.exec(
				"INSERT INTO events (seq, at, event) VALUES (?, ?, ?)",
				seq,
				event.at,
				JSON.stringify(event),
			);
		});
		this.#broadcast({ kind: "lifecycle", seq, event });
	}

	override webSocketClose(socket: WebSocket) {
		this.#left(socket);
	}

	override webSocketError(socket: WebSocket) {
		this.#left(socket);
	}

	/** Evicts silent hosts and prunes the log; it runs only while hosts are connected or events remain. */
	override async alarm() {
		const now = Date.now();
		for (const socket of this.#open()) {
			const { seen } = socket.deserializeAttachment() as Attachment;
			const pinged = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() || 0;
			if (now - Math.max(seen, pinged) > SILENT) this.#close(socket, "silent");
		}
		const sql = this.ctx.storage.sql;
		sql.exec("DELETE FROM events WHERE at < ?", now - RETAIN);
		sql.exec(
			"DELETE FROM events WHERE seq <= (SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?)",
			CAP,
		);
		if (this.#open().length) return this.ctx.storage.setAlarm(now + SWEEP);
		const oldest = sql.exec<{ at: number | null }>("SELECT min(at) AS at FROM events").one().at;
		if (oldest !== null) await this.ctx.storage.setAlarm(oldest + RETAIN);
	}

	#latest(): number {
		return this.ctx.storage.kv.get<number>("seq") || 0;
	}

	#open(): WebSocket[] {
		return this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN);
	}

	#close(socket: WebSocket, reason: string) {
		const { host } = socket.deserializeAttachment() as Attachment;
		log("warn", "lobby.close", { host, reason });
		socket.close(1000, reason);
		this.#left(socket);
	}

	#left(socket: WebSocket) {
		const { presence } = socket.deserializeAttachment() as Attachment;
		if (presence) this.#broadcast({ kind: "presence", people: this.#people() });
	}

	#people(): Presence[] {
		return this.#open().flatMap((socket) => {
			const { presence } = socket.deserializeAttachment() as Attachment;
			return presence ? [presence] : [];
		});
	}

	/**
	 * Sends the events after `since`, or asks the host to read listings again when they are gone:
	 * pruned, never seen, or from before this lobby's storage was reset.
	 */
	#replay(socket: WebSocket, since: number | undefined) {
		const sql = this.ctx.storage.sql;
		const latest = this.#latest();
		const oldest = sql.exec<{ seq: number | null }>("SELECT min(seq) AS seq FROM events").one().seq;
		const resync = since === undefined || since > latest || since < (oldest || latest + 1) - 1;
		if (!resync) {
			for (
				const row of sql.exec<{ seq: number; event: string }>(
					"SELECT seq, event FROM events WHERE seq > ? ORDER BY seq",
					since,
				)
			) {
				this.#send(socket, { kind: "lifecycle", seq: row.seq, event: JSON.parse(row.event) });
			}
		}
		this.#send(socket, { kind: "synced", seq: latest, resync });
	}

	#send(socket: WebSocket, down: LobbyDown) {
		socket.send(JSON.stringify(down));
	}

	#broadcast(down: LobbyDown) {
		const frame = JSON.stringify(down);
		for (const socket of this.#open()) {
			if ((socket.deserializeAttachment() as Attachment).host) socket.send(frame);
		}
	}
}
