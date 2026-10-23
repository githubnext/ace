import { DurableObject } from "cloudflare:workers";

import type { Lobby } from "./lobby";
import type { Share } from "./protocol";
import { authorized, refused } from "./scope";

export { Lobby } from "./lobby";

type Env = {
	DIRECTORY: DurableObjectNamespace<Directory>;
	/** One lobby per project, named by the project ID that hosts and apps share. */
	LOBBY: DurableObjectNamespace<Lobby>;
	/** The team's secret; hosts present it combined with `TAILNET` (see credential.ts). */
	ACE_SECRET?: string;
	/** The one tailnet this deployment serves, as its MagicDNS suffix. */
	TAILNET?: string;
	/** The team's deployed web app, which every host in the directory lets open its sockets. */
	APP?: string;
	/** The team's channel hosting service, which every host in the directory offers as a move destination. */
	HOSTED?: string;
	/** The team's cloud compute service, which hosts that have saved none of their own use. */
	COMPUTE?: string;
};

/** What a host publishes. Channel listings are opaque here: hosts define and read them. */
export type Publication = {
	/** The host's owner, by tailnet login. */
	login: string;
	/** The owner's GitHub login, when the host's GitHub CLI is signed in. */
	github?: string;
	/** Tailnet address, when the host has one. */
	address?: string;
	channels: { id: string }[];
};

export type Host = Omit<Publication, "channels"> & { name: string; seen: number };

/**
 * Applied in order and counted in the `version` key, since Durable Object SQLite refuses
 * `PRAGMA user_version`. Never edit one that has shipped. The first predates the key, so it must
 * stay idempotent for directories created before it.
 */
const MIGRATIONS = [
	`CREATE TABLE IF NOT EXISTS hosts (name TEXT PRIMARY KEY, host TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS channels (
		id TEXT PRIMARY KEY,
		host TEXT NOT NULL,
		listing TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS channels_host ON channels (host);`,
	`CREATE TABLE shares (
		project TEXT NOT NULL,
		person TEXT NOT NULL,
		shared_by TEXT NOT NULL,
		at INTEGER NOT NULL,
		PRIMARY KEY (project, person)
	);`,
];

/**
 * The team's list of hosts and where each channel lives. It answers lookups; channel traffic never
 * passes through it. Each publication replaces the host's whole channel set, so a removed channel
 * disappears on the host's next publish.
 */
export class Directory extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const version = ctx.storage.kv.get<number>("version") || 0;
		if (version >= MIGRATIONS.length) return;
		ctx.storage.transactionSync(() => {
			for (const migration of MIGRATIONS.slice(version)) ctx.storage.sql.exec(migration);
			ctx.storage.kv.put("version", MIGRATIONS.length);
		});
	}

	publish(name: string, publication: Publication): void {
		const { channels, ...rest } = publication;
		const host: Host = { ...rest, name, seen: Date.now() };
		const sql = this.ctx.storage.sql;
		// Hosts publish on every heartbeat, and Durable Objects bill each row written, so only changed
		// channels are written.
		this.ctx.storage.transactionSync(() => {
			sql.exec("INSERT OR REPLACE INTO hosts VALUES (?, ?)", name, JSON.stringify(host));
			const stored = new Map(
				sql.exec<{ id: string; listing: string }>(
					"SELECT id, listing FROM channels WHERE host = ?",
					name,
				).toArray().map((row) => [row.id, row.listing]),
			);
			for (const channel of channels) {
				const listing = JSON.stringify(channel);
				if (stored.get(channel.id) !== listing) {
					sql.exec("INSERT OR REPLACE INTO channels VALUES (?, ?, ?)", channel.id, name, listing);
				}
				stored.delete(channel.id);
			}
			for (const id of stored.keys()) sql.exec("DELETE FROM channels WHERE id = ?", id);
		});
	}

	leave(name: string): void {
		const sql = this.ctx.storage.sql;
		this.ctx.storage.transactionSync(() => {
			sql.exec("DELETE FROM hosts WHERE name = ?", name);
			sql.exec("DELETE FROM channels WHERE host = ?", name);
		});
	}

	read(): { hosts: Host[]; channels: unknown[]; shares: Share[] } {
		const sql = this.ctx.storage.sql;
		return {
			hosts: sql.exec<{ host: string }>("SELECT host FROM hosts").toArray().map((row) =>
				JSON.parse(row.host)
			),
			channels: sql.exec<{ listing: string }>("SELECT listing FROM channels").toArray().map((
				row,
			) => JSON.parse(row.listing)),
			shares: sql.exec<Share>('SELECT project, person, shared_by AS "by", at FROM shares')
				.toArray(),
		};
	}

	share(share: Share, shared: boolean): void {
		const sql = this.ctx.storage.sql;
		if (shared) {
			sql.exec(
				"INSERT OR REPLACE INTO shares VALUES (?, ?, ?, ?)",
				share.project,
				share.person,
				share.by,
				share.at,
			);
		} else {
			sql.exec("DELETE FROM shares WHERE project = ? AND person = ?", share.project, share.person);
		}
	}
}

function decoded(component: string): string | undefined {
	try {
		return decodeURIComponent(component);
	} catch {
		return undefined;
	}
}

const HOST = /^\/hosts\/([A-Za-z0-9._-]{1,128})$/;
const LOBBY = /^\/lobbies\/([^/]{1,1024})$/;

export default {
	async fetch(request, env) {
		if (!(await authorized(request, env))) return refused(env);
		const { pathname } = new URL(request.url);
		const lobby = LOBBY.exec(pathname);
		if (lobby && request.headers.get("upgrade") === "websocket") {
			const project = decoded(lobby[1]!);
			if (!project) return new Response("Malformed project ID", { status: 400 });
			return env.LOBBY.get(env.LOBBY.idFromName(project)).fetch(request);
		}
		const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("team"));
		if (pathname === "/" && request.method === "GET") {
			const { hosts, channels, shares } = await directory.read();
			return Response.json({
				hosts,
				channels,
				shares,
				app: env.APP,
				hosted: env.HOSTED,
				compute: env.COMPUTE,
			});
		}
		const host = HOST.exec(pathname);
		if (host && request.method === "PUT") {
			const publication = await request.json<Publication>();
			if (
				typeof publication.login !== "string" || !Array.isArray(publication.channels)
				|| (publication.github !== undefined && typeof publication.github !== "string")
			) {
				return new Response("Invalid publication", { status: 400 });
			}
			await directory.publish(host[1], publication);
			return new Response(null, { status: 204 });
		}
		if (host && request.method === "DELETE") {
			await directory.leave(host[1]);
			return new Response(null, { status: 204 });
		}
		if (pathname === "/shares" && request.method === "POST") {
			const { shared, ...share } = await request.json<Share & { shared: boolean }>();
			if (
				typeof share.project !== "string" || typeof share.person !== "string"
				|| typeof share.by !== "string" || typeof shared !== "boolean"
			) {
				return new Response("Invalid share", { status: 400 });
			}
			await directory.share({ ...share, at: Date.now() }, shared);
			return new Response(null, { status: 204 });
		}
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
