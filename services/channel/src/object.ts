import { DurableObject } from "cloudflare:workers";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { Channel, type Envelope, type Frame, type Log, type ModelRef } from "@ace/channel";
import {
	backupSnapshot,
	exportSnapshot,
	importSnapshot,
	isUnsettled,
	MAX_SNAPSHOT,
	type Snapshot,
} from "@ace/channel/transfer";
import {
	type Call,
	Link,
	PING,
	PONG,
	type Reply,
	type WorkspaceMessage,
} from "@ace/channel/workspace";

import { DurableSqlite } from "./storage";

export type Env = {
	CHANNEL: DurableObjectNamespace<HostedChannel>;
	/** The team's secret; hosts present it combined with `TAILNET` (see @ace/directory/credential). */
	ACE_SECRET?: string;
	/** The one tailnet this deployment serves, as its MagicDNS suffix. */
	TAILNET?: string;
};

/** Paths are on the workspace host, whose file namespace is `workspace`. */
export type Config = {
	version: 2;
	id: string;
	name: string;
	prefix: string;
	named: boolean;
	owner: string;
	project: string;
	lanes: string;
	model?: ModelRef;
	workspace: string;
};

const KEEPALIVE = 30_000;

/**
 * Where the channel's authority is. `inactive` holds an imported copy awaiting activation; `frozen`
 * has handed authority to another place. Objects created before moves existed have no stored state.
 */
type State = "active" | "inactive" | "frozen";

type Transfer =
	| { action: "import"; config: Config; snapshot: Snapshot }
	| { action: "activate"; digest: string }
	| { action: "freeze" }
	| { action: "export" }
	| { action: "backup" }
	| { action: "thaw" };

const MOVED = 4009;

function refuse(status: number, message: string): Response {
	return new Response(message, { status });
}

/** Workers Logs indexes JSON fields, so lines search by the same ids as hosts' log files. */
const log: Log = (level, event, fields) => {
	const line = { level, event, ...fields };
	if (level === "error") console.error(line);
	else if (level === "warn") console.warn(line);
	else console.log(line);
};

/**
 * One hosted channel. Its history and agents live here; its tools run on the workspace host that
 * holds the `workspace` socket. That socket hibernates, so an idle channel costs nothing while the
 * host stays connected. Client sockets stream live pi events and keep the object awake.
 */
export class HostedChannel extends DurableObject<Env> {
	#link = new Link(crypto.randomUUID());
	#db = new DurableSqlite(this.ctx.storage);
	#channel?: Promise<Channel>;
	/** Set synchronously when a freeze starts, so no request is admitted while it drains. */
	#gate = false;
	#pending = new Set<Promise<unknown>>();
	/** Transfer actions run one at a time, each reading placement only once it starts. */
	#transfers: Promise<unknown> = Promise.resolve();
	/** Client sockets are not hibernatable, so `getWebSockets` does not list them. */
	#clients = new Set<WebSocket>();
	/**
	 * Hibernation discards in-flight workspace calls while their processes keep running on the
	 * workspace. A pending timer prevents hibernation, so it lives exactly while a chat is busy.
	 */
	#resident?: ReturnType<typeof setTimeout>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Answered by the runtime, so a hibernated object stays asleep while its workspace pings.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
	}

	/** Each hold is a fresh bounded timer, renewed until the busy-to-idle transition clears it. */
	#reside(busy: boolean) {
		clearTimeout(this.#resident);
		this.#resident = busy ? setTimeout(() => this.#reside(true), KEEPALIVE) : undefined;
	}

	#config(): Config | undefined {
		const config = this.ctx.storage.kv.get<
			Omit<Config, "version" | "prefix" | "named"> & Partial<Pick<Config, "prefix" | "named">> & {
				version?: number;
			}
		>(
			"config",
		);
		if (!config) return;
		if (config.version !== undefined && config.version !== 1 && config.version !== 2) {
			throw new Error(`Unsupported channel config version ${config.version}`);
		}
		if (config.version === 2) return config as Config;
		return { ...config, version: 2, prefix: config.name, named: true };
	}

	#state(): State {
		return this.ctx.storage.kv.get<State>("state") || "active";
	}

	#project(message: WorkspaceMessage) {
		const frame = JSON.stringify(message);
		for (const socket of this.ctx.getWebSockets("workspace")) {
			if (socket.readyState === WebSocket.OPEN) socket.send(frame);
		}
	}

	#attach(socket: WebSocket) {
		this.#link.attach(
			(call: Call) => socket.send(JSON.stringify(call)),
			// Hosts that predate pings have no timestamp and are treated as answering.
			() => this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime(),
		);
	}

	#open(config: Config): Promise<Channel> {
		this.#channel ??= (async () => {
			const [socket] = this.ctx.getWebSockets("workspace");
			if (socket && !this.#link.attached) this.#attach(socket);
			const env = this.env as unknown as Record<string, unknown>;
			const envs = new Map<string, ReturnType<Link["env"]>>();
			return Channel.open({
				...config,
				onMetadata: (metadata) => this.#project({ metadata }),
				onActivity: (active) => this.#project({ active }),
				onRun: (ran) => this.#project({ ran }),
				onSaid: (said) => this.#project({ said }),
				onBusy: (busy) => {
					this.#reside(busy);
					this.#project({ busy });
				},
				storage: await SqliteStorage.open(this.#db),
				models: builtinModels({
					authContext: {
						env: async (name) => typeof env[name] === "string" ? env[name] : undefined,
						fileExists: async () => false,
					},
				}),
				desktop: (request, context) => this.#link.desktop(request, context),
				browser: (request, context) => this.#link.browser(request, context),
				images: (path, context) => this.#link.image(path, context),
				env: (cwd) => {
					let found = envs.get(cwd);
					if (!found) envs.set(cwd, found = this.#link.env(config.workspace, cwd));
					return found;
				},
				directory: {
					self: { id: config.id, name: config.prefix },
					list: async () => [],
					deliver: async () => {
						throw new Error("Hosted channels cannot message other channels yet");
					},
				},
				log,
			});
		})();
		return this.#channel;
	}

	/** Pi resumes interrupted work when it opens, so an alarm during a run brings an evicted object back. */
	async #keepalive() {
		if (!(await this.ctx.storage.getAlarm())) {
			await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE);
		}
	}

	override async alarm() {
		const config = this.#config();
		if (!config || this.#state() !== "active") return;
		// A freeze is deciding; a refused freeze leaves the channel needing its keepalive.
		if (this.#gate) return this.#keepalive();
		const channel = await this.#open(config);
		if (!(await channel.isIdle())) await this.#keepalive();
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/transfer")) {
			if (request.method !== "POST") return refuse(405, "Transfers are POST requests");
			return this.#transfer(request, url.pathname.split("/")[2]!);
		}
		if (this.#gate || this.#state() !== "active") return refuse(409, "The channel moved");
		// A freeze waits for admitted requests, which may still be opening the channel.
		const handled = this.#ordinary(request, url);
		this.#pending.add(handled);
		handled.finally(() => this.#pending.delete(handled)).catch(() => {});
		return handled;
	}

	async #ordinary(request: Request, url: URL): Promise<Response> {
		const workspace = url.pathname.endsWith("/workspace");
		if (request.method === "POST") {
			if (!this.#config()) this.ctx.storage.kv.put("config", await request.json<Config>());
			return Response.json(await (await this.#open(this.#config()!)).info());
		}
		const config = this.#config();
		if (!config) return new Response("No such channel", { status: 404 });
		if (request.method === "DELETE") {
			const channel = await this.#open(config);
			await channel.kill();
			await channel.close();
			this.#channel = undefined;
			for (const socket of this.ctx.getWebSockets()) socket.close(1000, "deleted");
			await this.ctx.storage.deleteAll();
			return new Response(null, { status: 204 });
		}
		if (request.headers.get("upgrade") !== "websocket") {
			return Response.json(await (await this.#open(config)).info());
		}
		const { 0: client, 1: server } = new WebSocketPair();
		if (workspace) {
			for (const old of this.ctx.getWebSockets("workspace")) old.close(1000, "replaced");
			log("info", "workspace.connect", { channel: config.id, workspace: config.workspace });
			this.ctx.acceptWebSocket(server, ["workspace"]);
			this.#attach(server);
			const channel = await this.#open(config);
			const { name, summary, revision } = await channel.info();
			this.#project({ metadata: { name, summary, revision } });
			// Reconnects need current state even if no run transition occurred while disconnected.
			this.#project({ busy: channel.busy });
		} else {
			server.accept();
			this.#serve(server, await this.#open(config));
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
		// A hibernated workspace socket can outlive a freeze; its replies must not reattach.
		if (this.#state() !== "active") return socket.close(MOVED, "moved");
		if (!this.#link.attached) this.#attach(socket);
		this.#link.receive(JSON.parse(message as string) as Reply);
	}

	override async webSocketClose(socket: WebSocket, code: number, reason: string) {
		log("warn", "workspace.drop", { channel: this.#config()?.id, code, reason });
		if (this.ctx.getWebSockets("workspace").every((open) => open === socket)) this.#link.detach();
	}

	#serve(socket: WebSocket, channel: Channel) {
		const watches: { stop(): Promise<unknown> }[] = [];
		const send = (frame: Frame) => socket.send(JSON.stringify(frame));
		this.#clients.add(socket);
		socket.addEventListener("close", () => {
			this.#clients.delete(socket);
			for (const watch of watches) watch.stop();
		});
		socket.addEventListener("message", ({ data }) => {
			const { id, trace, ...body } = JSON.parse(data as string) as Envelope;
			if (this.#gate || this.#state() !== "active") {
				return send({ id, ok: false, error: "The channel moved" });
			}
			const handled = (async () => {
				try {
					const value = await channel.handle(body, (event) => send({ id, event }), trace);
					if (body.op === "watch") watches.push(value as { stop(): Promise<unknown> });
					if (body.op === "ask") await this.#keepalive();
					send({ id, ok: true, value: body.op === "watch" ? null : value ?? null });
				} catch (error) {
					send({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			})();
			// `wait` lasts as long as a run, and a busy channel refuses to freeze anyway.
			if (body.op === "wait") return;
			this.#pending.add(handled);
			handled.finally(() => this.#pending.delete(handled)).catch(() => {});
		});
	}

	/**
	 * Moves between a host and this object. Every refusal names the state it left, so a host whose
	 * answer was lost can tell whether authority changed.
	 */
	async #transfer(request: Request, id: string): Promise<Response> {
		if (Number(request.headers.get("content-length")) > MAX_SNAPSHOT + 65_536) {
			return refuse(413, "Channel snapshot is too large to move");
		}
		const bytes = await request.arrayBuffer();
		if (bytes.byteLength > MAX_SNAPSHOT + 65_536) {
			return refuse(413, "Channel snapshot is too large to move");
		}
		let body: Transfer;
		try {
			body = JSON.parse(new TextDecoder().decode(bytes)) as Transfer;
		} catch {
			return refuse(400, "Transfer body is not JSON");
		}
		// Overlapping actions would read placement before another changes it, so a host could
		// take a refusal as proof that an activation which then succeeded never happened.
		const result = this.#transfers.then(() => this.#act(body, id));
		this.#transfers = result.catch(() => {});
		return result;
	}

	async #act(body: Transfer, id: string): Promise<Response> {
		const config = this.#config();
		const state = config ? this.#state() : undefined;
		const refused = (message: string) => refuse(409, `${message} (state: ${state || "empty"})`);
		switch (body.action) {
			case "import":
				return this.#import(body, id, config, state);
			case "activate": {
				if (!config) return refused("Nothing was imported");
				const digest = this.ctx.storage.kv.get<string>("digest");
				if (body.digest !== digest) return refused("Digest does not match the imported snapshot");
				if (state === "active") return Response.json(await (await this.#open(config)).info());
				if (state !== "inactive") return refused("Only an imported channel can be activated");
				try {
					const info = await (await this.#open(config)).info();
					// Authority changes only once the imported channel has opened.
					this.ctx.storage.kv.put("state", "active");
					log("info", "transfer.activate", { channel: config.id, digest });
					return Response.json(info);
				} catch (error) {
					await this.#close();
					const message = error instanceof Error ? error.message : String(error);
					return refuse(500, `Activation failed: ${message} (state: inactive)`);
				}
			}
			case "freeze":
				if (!config) return refused("No such channel");
				if (state === "frozen") return Response.json({ digest: this.ctx.storage.kv.get("digest") });
				if (state !== "active") return refused("Only an active channel can be frozen");
				return this.#freeze(config);
			case "export":
				if (state !== "frozen") return refused("Only a frozen channel can be exported");
				return Response.json(await exportSnapshot(this.#db, config!.id));
			case "backup": {
				if (state !== "active" && state !== "frozen") return refused("Nothing to back up here");
				// Every pi read and write goes through #db, which runs this transaction alone, so the
				// snapshot is consistent without freezing the channel.
				try {
					return Response.json(await backupSnapshot(this.#db, config!.id));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return refused(`Backup failed: ${message}`);
				}
			}
			case "thaw":
				if (state !== "frozen") return refused("Only a frozen channel can be thawed");
				this.ctx.storage.kv.put("state", "active");
				log("warn", "transfer.thaw", { channel: config!.id });
				return Response.json({ state: "active" });
			default:
				return refuse(400, "Unknown transfer action");
		}
	}

	async #import(
		body: Extract<Transfer, { action: "import" }>,
		id: string,
		existing: Config | undefined,
		state: State | undefined,
	): Promise<Response> {
		const { config, snapshot } = body;
		const where = `(state: ${state || "empty"})`;
		if (config?.version !== 2 || config.id !== id || snapshot?.channel !== id) {
			return refuse(400, `Config and snapshot must both be version 2 channel ${id} ${where}`);
		}
		if (existing) {
			if (state === "active") return refuse(409, `The channel is active here ${where}`);
			const same = existing.id === config.id && existing.owner === config.owner
				&& existing.workspace === config.workspace && existing.project === config.project
				&& existing.lanes === config.lanes;
			if (!same) return refuse(409, `A different channel is stored here ${where}`);
		}
		try {
			const result = await importSnapshot(this.#db, snapshot, {
				replace: !!existing,
				install: async () => {
					this.ctx.storage.kv.put("config", config);
					this.ctx.storage.kv.put("state", "inactive");
					this.ctx.storage.kv.put("digest", snapshot.digest);
				},
			});
			log("info", "transfer.import", { channel: id, ...result });
			return Response.json(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return refuse(409, `Import refused: ${message} ${where}`);
		}
	}

	async #freeze(config: Config): Promise<Response> {
		this.#gate = true;
		try {
			await Promise.allSettled(this.#pending);
			const channel = await this.#channel?.catch(() => undefined);
			if (channel?.busy || (await isUnsettled(this.#db))) {
				return refuse(409, "The channel is busy; wait until it is idle (state: active)");
			}
			this.ctx.storage.kv.put("state", "frozen");
		} finally {
			this.#gate = false;
		}
		log("info", "transfer.freeze", { channel: config.id });
		try {
			for (const socket of [...this.ctx.getWebSockets(), ...this.#clients]) {
				socket.close(MOVED, "moved");
			}
			this.#link.detach();
			await this.ctx.storage.deleteAlarm();
			await this.#close();
			const { digest } = await exportSnapshot(this.#db, config.id);
			this.ctx.storage.kv.put("digest", digest);
			return Response.json({ digest });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return refuse(500, `Frozen, but closing or exporting failed: ${message} (state: frozen)`);
		}
	}

	async #close() {
		const opening = this.#channel;
		this.#channel = undefined;
		const channel = await opening?.catch(() => undefined);
		await channel?.close();
		this.#reside(false);
	}
}
