import { DurableObject } from "cloudflare:workers";

import { validateName } from "@ace/channel";
import type { ModelRef } from "@ace/channel/protocol";

import channels from "../channel/src/index";
import type { Env as ChannelEnv } from "../channel/src/object";

export { HostedChannel } from "../channel/src/object";

type Env = ChannelEnv & {
	COMPUTE: DurableObjectNamespace<Compute>;
	GITHUB_TOKEN?: string;
};
const SIZES = ["standard-1", "standard-2", "standard-3", "standard-4"] as const;
type Size = typeof SIZES[number];
type Settings = {
	id: string;
	repository: string;
	hosted: string;
	/** The Git author; the channel's owner is the Ace user in its own config. */
	owner: { name: string; email: string };
	size: Size;
	started?: boolean;
};
type Manifest = {
	version: 1;
	generation: string;
	chunks: number;
	bytes: number;
	sha256: string;
	at: number;
};
const CHUNK = 64 * 1024;
const MAX = 16 * 1024 * 1024;
const INACTIVITY = 6 * 60 * 60 * 1000;

function size(value: unknown): Size {
	if (!SIZES.includes(value as Size)) throw new Error(`Size must be ${SIZES.join(", ")}`);
	return value as Size;
}

async function digest(bytes: Uint8Array): Promise<string> {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Pilot checkpoints contain filesystem state only. Channel history remains in pi. */
export class Compute extends DurableObject<Env> {
	#queue: Promise<unknown> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		if (ctx.container?.running) {
			void ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(INACTIVITY));
		}
	}

	#settings(): Settings {
		const settings = this.ctx.storage.kv.get<Settings>("settings");
		if (!settings) throw new Error("Initialize this pilot first");
		return settings;
	}

	async #channel(action: "freeze" | "thaw") {
		const { id } = this.#settings();
		const response = await this.env.CHANNEL.getByName(id).fetch(
			`https://channel/channels/${id}/transfer`,
			{
				method: "POST",
				body: JSON.stringify({ action }),
			},
		);
		if (!response.ok) {
			const message = await response.text();
			if (action === "thaw" && message === "Only a frozen channel can be thawed (state: active)") {
				this.ctx.storage.kv.put("frozen", false);
				return;
			}
			if (message.endsWith("(state: frozen)")) this.ctx.storage.kv.put("frozen", true);
			throw new Error(message);
		}
		this.ctx.storage.kv.put("frozen", action === "freeze");
	}

	async #call(path: string, body?: unknown): Promise<Response> {
		if (!this.ctx.container?.running) throw new Error("The sandbox is stopped");
		const response = await this.ctx.container.getTcpPort(8080).fetch(`http://container${path}`, {
			method: body === undefined ? "GET" : "POST",
			body: body === undefined
				? undefined
				: body instanceof Uint8Array
				? body
				: JSON.stringify(body),
		});
		if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
		return response;
	}

	async #boot(selected: Size) {
		const container = this.ctx.container!;
		container.start({ image: container.images.base, instance: selected, enableInternet: true });
		await container.setInactivityTimeout(INACTIVITY);
		for (let attempt = 0; attempt < 120; attempt++) {
			try {
				await this.#call("/health");
				return;
			} catch {
				await scheduler.wait(1000);
			}
		}
		throw new Error("Sandbox did not become ready in 120 seconds");
	}

	async #connect(thaw = true) {
		const settings = this.#settings();
		await this.#call("/setup", {
			repository: settings.repository,
			channel: settings.id,
			hosted: settings.hosted,
			secret: this.env.ACE_SECRET,
			gitToken: this.env.GITHUB_TOKEN,
			owner: settings.owner,
		});
		if (thaw && this.ctx.storage.kv.get("frozen")) await this.#channel("thaw");
	}

	async #save(): Promise<Manifest> {
		await this.#channel("freeze");
		try {
			return await this.#capture();
		} catch (error) {
			// A refused checkpoint must leave the live filesystem usable, never destroy it.
			await this.#connect();
			throw error;
		}
	}

	async #capture(): Promise<Manifest> {
		await this.#call("/disconnect", {});
		const bytes = new Uint8Array(await (await this.#call("/checkpoint")).arrayBuffer());
		if (!bytes.byteLength || bytes.byteLength > MAX) {
			throw new Error("Checkpoint exceeds the pilot's 16 MiB limit");
		}
		const previous = this.ctx.storage.kv.get<Manifest>("checkpoint");
		const manifest: Manifest = {
			version: 1,
			generation: crypto.randomUUID(),
			chunks: Math.ceil(bytes.byteLength / CHUNK),
			bytes: bytes.byteLength,
			sha256: await digest(bytes),
			at: Date.now(),
		};
		this.ctx.storage.transactionSync(() => {
			for (let i = 0; i < manifest.chunks; i++) {
				this.ctx.storage.kv.put(
					`${manifest.generation}:${i}`,
					bytes.slice(i * CHUNK, (i + 1) * CHUNK),
				);
			}
			this.ctx.storage.kv.put("checkpoint", manifest);
			if (previous) {
				for (let i = 0; i < previous.chunks; i++) {
					this.ctx.storage.kv.delete(`${previous.generation}:${i}`);
				}
			}
		});
		return manifest;
	}

	async #restore(manifest: Manifest) {
		if (manifest.version !== 1) throw new Error("Unsupported checkpoint version");
		const bytes = new Uint8Array(manifest.bytes);
		for (let i = 0; i < manifest.chunks; i++) {
			const chunk = this.ctx.storage.kv.get<Uint8Array>(`${manifest.generation}:${i}`);
			if (!chunk) throw new Error(`Missing checkpoint chunk ${i}`);
			bytes.set(chunk, i * CHUNK);
		}
		if (await digest(bytes) !== manifest.sha256) throw new Error("Checkpoint checksum mismatch");
		await this.#call("/restore", bytes);
	}

	async #start(selected: Size) {
		const settings = this.#settings();
		if (this.ctx.container!.running) {
			if (this.ctx.storage.kv.get("frozen") && !this.ctx.storage.kv.get("ready")) {
				await this.ctx.container!.destroy();
			} else {
				throw new Error("Sandbox is already running; use resize to change its size");
			}
		}
		const manifest = this.ctx.storage.kv.get<Manifest>("checkpoint");
		if (settings.started && !manifest) {
			throw new Error(
				"The sandbox was lost without a checkpoint; refusing to create an empty replacement",
			);
		}
		await this.#channel("freeze");
		this.ctx.storage.kv.put("ready", false);
		try {
			await this.#boot(selected);
			if (manifest) await this.#restore(manifest);
			await this.#connect(false);
		} catch (error) {
			// No channel input can reach this incomplete replacement while it is frozen.
			await this.ctx.container!.destroy();
			throw error;
		}
		this.ctx.storage.kv.put("settings", { ...settings, size: selected, started: true });
		this.ctx.storage.kv.put("ready", true);
		await this.#channel("thaw");
	}

	async #handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const [, , id, action = "status"] = url.pathname.split("/");
		if (action === "status" && request.method === "GET") {
			return Response.json({
				running: this.ctx.container!.running,
				settings: this.ctx.storage.kv.get("settings"),
				checkpoint: this.ctx.storage.kv.get("checkpoint"),
				frozen: !!this.ctx.storage.kv.get("frozen"),
				runner: this.ctx.container!.running ? await (await this.#call("/status")).json() : null,
			});
		}
		if (request.method !== "POST") return new Response("Use POST", { status: 405 });
		const body = await request.json() as Record<string, unknown>;
		if (action === "init") {
			if (this.ctx.storage.kv.get("settings")) throw new Error("Pilot already initialized");
			const repository = new URL(String(body.repository));
			if (
				repository.protocol !== "https:" || repository.hostname !== "github.com"
				|| repository.username || repository.password || repository.search || repository.hash
			) throw new Error("Use a GitHub HTTPS repository URL without credentials");
			const author = body.author as Settings["owner"];
			if (typeof body.owner !== "string" || !body.owner) {
				throw new Error("Owner is the Ace user who owns the channel");
			}
			if (!author?.name || !author.email) throw new Error("Author name and email are required");
			const name = validateName(String(body.name || id));
			const settings: Settings = {
				id,
				repository: repository.href,
				hosted: url.origin,
				owner: author,
				size: size(body.size || "standard-1"),
			};
			const response = await this.env.CHANNEL.getByName(id).fetch(
				`https://channel/channels/${id}`,
				{
					method: "POST",
					body: JSON.stringify({
						version: 2,
						id,
						name,
						prefix: validateName(String(body.prefix || name)),
						named: !!body.named,
						owner: body.owner,
						project: "/workspace/project",
						lanes: "/workspace/lanes",
						workspace: `compute:${id}`,
						model: body.model as ModelRef | undefined,
					}),
				},
			);
			if (!response.ok) throw new Error(await response.text());
			this.ctx.storage.kv.put("settings", settings);
			return Response.json(settings);
		}
		const settings = this.#settings();
		if (
			["exec", "checkpoint", "stop", "resize"].includes(action) && !this.ctx.storage.kv.get("ready")
		) {
			throw new Error("Startup is incomplete; retry start before changing the workspace");
		}
		if (
			["exec", "checkpoint", "stop", "resize", "resume"].includes(action)
			&& !this.ctx.container!.running
		) {
			throw new Error("The sandbox is stopped; use start to restore it");
		}
		switch (action) {
			case "resume":
				if (!this.ctx.storage.kv.get("frozen")) throw new Error("The pilot is not frozen");
				if (!this.ctx.storage.kv.get("ready")) {
					throw new Error("Startup is incomplete; retry start");
				}
				await this.#channel("freeze");
				await this.#connect();
				return Response.json({ resumed: true });
			case "start":
				await this.#start(size(body.size || settings.size));
				return Response.json({ started: true });
			case "exec":
				await this.#channel("freeze");
				try {
					return await this.#call("/exec", body);
				} finally {
					await this.#connect();
				}
			case "checkpoint": {
				const checkpoint = await this.#save();
				await this.#connect();
				return Response.json(checkpoint);
			}
			case "stop": {
				const checkpoint = await this.#save();
				await this.ctx.container!.destroy();
				await this.#channel("thaw");
				return Response.json({ stopped: true, checkpoint });
			}
			case "resize": {
				const selected = size(body.size);
				const checkpoint = await this.#save();
				await this.ctx.container!.destroy();
				await this.#start(selected);
				return Response.json({ size: selected, checkpoint });
			}
			default:
				return new Response("Unknown pilot operation", { status: 404 });
		}
	}

	override fetch(request: Request): Promise<Response> {
		const result = this.#queue.then(() => this.#handle(request));
		this.#queue = result.catch(() => {});
		return result.catch((error: Error) => Response.json({ error: error.message }, { status: 409 }));
	}
}

export default {
	async fetch(request, env) {
		const path = new URL(request.url).pathname;
		if (path.startsWith("/channels/")) return channels.fetch(request, env);
		const match = /^\/workspaces\/([a-z0-9-]{1,64})(?:\/[a-z-]+)?$/.exec(path);
		if (!match) return new Response("Not found", { status: 404 });
		const encoder = new TextEncoder();
		const given = encoder.encode(request.headers.get("authorization") || "");
		const expected = encoder.encode(`Bearer ${env.ACE_SECRET}`);
		if (
			!env.ACE_SECRET || given.length !== expected.length
			|| !crypto.subtle.timingSafeEqual(given, expected)
		) return new Response("Unauthorized", { status: 401 });
		return env.COMPUTE.getByName(match[1]).fetch(request);
	},
} satisfies ExportedHandler<Env>;
