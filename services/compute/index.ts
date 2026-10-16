import type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { cloudflare } from "@sandbox-sdk/cloudflare";
import { create, type Sandbox } from "@sandbox-sdk/core";
import { DurableObject } from "cloudflare:workers";

import { validateName } from "@ace/channel";
import type { ModelRef } from "@ace/channel/protocol";
import { credential } from "@ace/directory/credential";
import { authorized, refused } from "@ace/directory/scope";

import channels from "../channel/src/index";
import type { Env as ChannelEnv } from "../channel/src/object";

export { Sandbox } from "@cloudflare/sandbox";
export { HostedChannel } from "../channel/src/object";

type Env = ChannelEnv & {
	COMPUTE: DurableObjectNamespace<Compute>;
	Sandbox: DurableObjectNamespace<CloudflareSandbox>;
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
const INACTIVITY = "6h";

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
	#sandbox: Promise<Sandbox> | undefined;

	/** A container that restarted has lost its runner, so only a live runner counts as running. */
	async #running(): Promise<boolean> {
		if (await (await this.#box()).status() !== "running") return false;
		try {
			await this.#call("/health");
			return true;
		} catch {
			return false;
		}
	}

	/** The workspace is a Sandbox SDK sandbox; only this adapter choice names a provider. */
	#box(): Promise<Sandbox> {
		this.#sandbox ||= create({
			adapter: cloudflare({
				binding: this.env.Sandbox,
				id: this.#settings().id,
				options: { sleepAfter: INACTIVITY },
			}),
		});
		return this.#sandbox;
	}

	async #destroy() {
		const box = await this.#box();
		this.#sandbox = undefined;
		await box.stop();
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

	/**
	 * Bodies travel as files and the request runs inside the sandbox, so the runner needs no
	 * exposed port on any provider.
	 */
	async #call(path: string, body?: unknown): Promise<Response> {
		const box = await this.#box();
		let post = "";
		if (body !== undefined) {
			await box.files.write(
				"/tmp/ace-request",
				body instanceof Uint8Array ? body : JSON.stringify(body),
			);
			post = "-X POST --data-binary @/tmp/ace-request";
		}
		const result = await box.process.shell(
			`curl -sS -o /tmp/ace-reply -w '%{http_code}' ${post} http://localhost:8080${path}; rm -f /tmp/ace-request`,
			// Marked so the runner's quiescence check ignores this request's own processes.
			{ timeout: 300_000, env: { ACE_CONTROL: "1" } },
		);
		const status = Number(result.stdout);
		if (!status) throw new Error(`${path}: ${result.stderr}`);
		const response = new Response(await box.files.read("/tmp/ace-reply"), { status });
		if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
		return response;
	}

	/** The container's instance type is fixed in wrangler.jsonc; the SDK has no portable size. */
	async #boot(_selected: Size) {
		const box = await this.#box();
		await box.process.spawnShell("bun --no-env-file runner.js", { cwd: "/app" });
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
			secret: await credential(this.env.ACE_SECRET!, this.env.TAILNET!),
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
		const incomplete = this.ctx.storage.kv.get("frozen") && !this.ctx.storage.kv.get("ready");
		if (!incomplete && await this.#running()) {
			throw new Error("Sandbox is already running; use resize to change its size");
		}
		// Clears an incomplete start or a container that restarted without its runner.
		await this.#destroy();
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
			await this.#destroy();
			throw error;
		}
		this.ctx.storage.kv.put("settings", { ...settings, size: selected, started: true });
		this.ctx.storage.kv.put("ready", true);
		await this.#channel("thaw");
	}

	/**
	 * Deleting is permanent, so the container goes without a checkpoint. Each step tolerates a
	 * previous attempt having done it, so a retry after a partial failure finishes the job.
	 */
	async #delete(id: string) {
		await this.#destroy();
		const channel = this.env.CHANNEL.getByName(id);
		// A frozen channel refuses deletion; a thaw refused because it is active or gone is harmless.
		await channel.fetch(`https://channel/channels/${id}/transfer`, {
			method: "POST",
			body: JSON.stringify({ action: "thaw" }),
		});
		const response = await channel.fetch(`https://channel/channels/${id}`, { method: "DELETE" });
		if (!response.ok && response.status !== 404) throw new Error(await response.text());
		await this.ctx.storage.deleteAll();
	}

	async #handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const [, , id, named] = url.pathname.split("/");
		if (request.method === "DELETE" && !named) {
			await this.#delete(id);
			return Response.json({ deleted: true });
		}
		const action = named || "status";
		if (action === "status" && request.method === "GET") {
			const running = await this.#running();
			return Response.json({
				running,
				settings: this.ctx.storage.kv.get("settings"),
				checkpoint: this.ctx.storage.kv.get("checkpoint"),
				frozen: !!this.ctx.storage.kv.get("frozen"),
				runner: running ? await (await this.#call("/status")).json() : null,
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
			&& !(await this.#running())
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
				await this.#destroy();
				await this.#channel("thaw");
				return Response.json({ stopped: true, checkpoint });
			}
			case "resize": {
				const selected = size(body.size);
				const checkpoint = await this.#save();
				await this.#destroy();
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
		if (!(await authorized(request, env))) return refused(env);
		return env.COMPUTE.getByName(match[1]).fetch(request);
	},
} satisfies ExportedHandler<Env>;
