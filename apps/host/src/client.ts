import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { connect as dial, type Socket } from "node:net";

import type { Frame, Request } from "@ace/channel/protocol";
import { credential } from "@ace/directory/credential";

import * as catalog from "./catalog";
import { config } from "./config";
import type { Watch } from "./gateway-client";
import { key, workerEnv } from "./keys";
import { lines } from "./lines";
import { failure, log } from "./log";
import { CHANNEL_CLOSED, type WorkerRequest } from "./protocol";
import * as tailnet from "./tailnet";

function start(id: string): void {
	// Output the worker didn't log itself, such as a crash before its log opens.
	const out = openSync(catalog.paths(id).log, "a");
	const [executable, ...args] = config.worker;
	try {
		const child = spawn(executable, [...args, id], {
			detached: true,
			stdio: ["ignore", out, out],
			env: workerEnv(),
		});
		child.on(
			"error",
			(error) => log("error", "worker.spawn.failed", { channel: id, ...failure(error) }),
		);
		child.unref();
		log("info", "worker.spawn", { channel: id, pid: child.pid });
	} finally {
		closeSync(out);
	}
}

function attempt(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = dial(path);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

type Transport = {
	write(text: string): void;
	end(): void;
	closed: Promise<void>;
};

function local(socket: Socket, receive: (text: string) => void): Transport {
	lines(socket, receive);
	return {
		write: (text) => socket.write(`${text}\n`),
		end: () => socket.end(),
		closed: new Promise((resolve) => socket.once("close", () => resolve())),
	};
}

/** Hosts hold the team's secret for its services: hosted channels and the directory. */
export async function hostedAuth(): Promise<Record<string, string>> {
	const secret = await key("ACE_SECRET");
	if (!secret) {
		throw new Error(
			"The team's services need ACE_SECRET. Add it in Settings → Team, or with ace key set ACE_SECRET",
		);
	}
	return serviceAuth(secret);
}

/** The team's services serve one tailnet, so the credential combines the secret with this Mac's. */
export async function serviceAuth(secret: string): Promise<Record<string, string>> {
	const domain = await tailnet.domain();
	if (!domain) throw new Error("The team's services need Tailscale running on this Mac.");
	return { authorization: `Bearer ${await credential(secret, domain)}` };
}

/** Why a team service refused this host, naming both tailnets when they differ. */
export async function rejection(response: Response, service: string): Promise<string> {
	await response.body?.cancel();
	const served = response.headers.get("ace-tailnet");
	const domain = await tailnet.domain();
	if (!served) {
		return `${service} names no tailnet: it predates tailnet-scoped services or lacks its TAILNET setting. Check its URL against your team's current services.`;
	}
	if (domain && served !== domain) {
		return `${service} serves the ${served} tailnet, but this Mac is on ${domain}. Switch tailnets, or use services deployed for this one.`;
	}
	return `${service} rejected this host's ACE_SECRET. Ask whoever set it up for the team's secret.`;
}

export async function hostedSocket(base: string, path: string): Promise<WebSocket> {
	const socket = new WebSocket(`${base.replace(/^http/, "ws")}${path}`, {
		headers: await hostedAuth(),
	} as unknown as string[]);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", () => {
			log("warn", "hosted.unreachable", { base, path });
			reject(new Error(`Cannot reach ${base}`));
		}, { once: true });
	});
	return socket;
}

async function hosted(
	base: string,
	id: string,
	receive: (text: string) => void,
): Promise<Transport> {
	const socket = await hostedSocket(base, `/channels/${id}`);
	socket.addEventListener("message", ({ data }) => receive(String(data)));
	return {
		write: (text) => socket.send(text),
		end: () => socket.close(),
		closed: new Promise((resolve) => socket.addEventListener("close", () => resolve())),
	};
}

/** A connection to a channel: its local worker, started if dormant, or its hosting service. */
export class Connection {
	#transport!: Transport;
	#next = 1;
	#pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	#watchers = new Map<number, Watch>();
	#released = false;
	closed!: Promise<void>;

	private constructor() {}

	static async #connect(open: (receive: (text: string) => void) => Promise<Transport>) {
		const connection = new Connection();
		connection.#transport = await open((text) => connection.#receive(JSON.parse(text)));
		connection.closed = connection.#transport.closed;
		connection.closed.then(() => {
			const error = CHANNEL_CLOSED;
			// Every accepted watch ends here, so relays can drop it; its owner decides whether to watch again.
			for (const [id, watch] of connection.#watchers) {
				if (connection.#pending.has(id)) continue;
				watch.closed?.(connection.#released ? "The watch was released" : error);
			}
			connection.#watchers.clear();
			for (const { reject } of connection.#pending.values()) reject(new Error(error));
			connection.#pending.clear();
		});
		return connection;
	}

	/** A hosted channel, which need not be in this host's catalog. */
	static hosted(base: string, id: string): Promise<Connection> {
		return Connection.#connect((receive) => hosted(base, id, receive));
	}

	/** Shutdown must never start a dormant worker. */
	static async running(id: string): Promise<Connection | undefined> {
		try {
			const socket = await attempt(catalog.paths(id).socket);
			return Connection.#connect(async (receive) => local(socket, receive));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
		}
	}

	static async open(id: string): Promise<Connection> {
		const record = catalog.read(id);
		if (record.moving) throw new Error("The channel is moving");
		if (record.hosted) return Connection.hosted(record.hosted, id);
		const { socket } = catalog.paths(id);
		let started = false;
		for (let wait = 50; wait < 10_000; wait *= 1.5) {
			try {
				const connected = await attempt(socket);
				return Connection.#connect(async (receive) => local(connected, receive));
			} catch {
				// A delete holds the worker lock until the record is gone; nothing is left to start.
				if (!existsSync(catalog.paths(id).record)) throw new Error("The channel was deleted");
				if (!started) start(id);
				started = true;
				await Bun.sleep(wait);
			}
		}
		log("error", "worker.unreachable", { channel: id });
		throw new Error(`The channel worker did not start; see ace logs --channel ${id}`);
	}

	request<T = unknown>(
		request: Request | WorkerRequest,
		watch?: Watch,
		trace?: string,
	): Promise<T> {
		const id = this.#next++;
		if (watch) this.#watchers.set(id, watch);
		this.#transport.write(JSON.stringify({ id, ...(trace ? { trace } : {}), ...request }));
		return new Promise((resolve, reject) =>
			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
		);
	}

	close(): void {
		this.#released = true;
		this.#transport.end();
	}

	#receive(frame: Frame) {
		if ("event" in frame) return this.#watchers.get(frame.id)?.event(frame.event);
		const pending = this.#pending.get(frame.id);
		this.#pending.delete(frame.id);
		if (frame.ok) return pending?.resolve(frame.value);
		this.#watchers.delete(frame.id);
		pending?.reject(new Error(frame.error));
	}
}

export async function request<T = unknown>(id: string, body: Request): Promise<T> {
	const connection = await Connection.open(id);
	try {
		return await connection.request<T>(body);
	} finally {
		connection.close();
	}
}
