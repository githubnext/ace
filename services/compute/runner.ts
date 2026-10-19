import { existsSync } from "node:fs";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

import {
	PING,
	PING_INTERVAL,
	PONG,
	serve,
	STALE,
	type WorkspaceMessage,
} from "@ace/channel/workspace";

import {
	checkpoint,
	MAX_CHECKPOINT_BYTES,
	PROJECT_ROOT,
	restore,
	WORKSPACE_ROOT,
} from "./checkpoint";
import { assertQuiescent, initializeQuiescence } from "./quiescence";

type Setup = {
	repository: string;
	channel: string;
	hosted: string;
	secret: string;
	gitToken?: string;
	owner: { name: string; email: string };
	/** A moved channel's project path on its old host, which its records still name. */
	project?: string;
	lanes?: { path: string; branch: string; base?: string }[];
};

const MAX_OUTPUT = 64 * 1024;
const GIT_TOKEN = "/run/ace-git-token";
const GIT_HELPER = "/run/ace-git-helper";
const environments = new Map<string, NodeExecutionEnv>();
let configuration: Setup | undefined;
let link: ReturnType<typeof connect> | undefined;
let operation = false;

function redact(text: string, setup = configuration): string {
	for (
		const value of [
			setup?.secret,
			setup?.gitToken,
			setup?.gitToken && Buffer.from(`x-access-token:${setup.gitToken}`).toString("base64"),
		]
	) {
		if (value) text = text.replaceAll(value, "[redacted]");
	}
	return text;
}

function shellEnv(setup = configuration): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
	if (setup?.gitToken) {
		// Routine env/config output may be saved in the project, so it must contain no token.
		env.GIT_CONFIG_COUNT = "3";
		env.GIT_CONFIG_KEY_0 = "credential.helper";
		env.GIT_CONFIG_VALUE_0 = "";
		env.GIT_CONFIG_KEY_1 = `credential.${setup.repository}.helper`;
		env.GIT_CONFIG_VALUE_1 = GIT_HELPER;
		env.GIT_CONFIG_KEY_2 = "credential.useHttpPath";
		env.GIT_CONFIG_VALUE_2 = "true";
	}
	return env;
}

function environment(cwd: string): NodeExecutionEnv {
	let env = environments.get(cwd);
	if (!env) {
		env = new NodeExecutionEnv({ cwd, shellEnv: shellEnv() });
		environments.set(cwd, env);
	}
	return env;
}

async function cleanup(): Promise<void> {
	await Promise.all([...environments.values()].map((env) => env.cleanup(BACKGROUND_CONTEXT)));
	environments.clear();
}

async function command(text: string, cwd: string, signal?: AbortSignal) {
	let output = "";
	let truncated = false;
	const env = new NodeExecutionEnv({ cwd, shellEnv: shellEnv() });
	try {
		const result = await env.exec(text, {
			timeout: 240,
			onOutput: (chunk) => {
				if (output.length + chunk.length > MAX_OUTPUT) truncated = true;
				output = (output + chunk).slice(-MAX_OUTPUT);
			},
		}, signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT);
		if (!result.ok) throw new Error(result.error.message);
		return { ...result.value, output: redact(output), truncated };
	} finally {
		await env.cleanup(BACKGROUND_CONTEXT);
	}
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function credentials(setup: Setup): Promise<void> {
	await rm(GIT_TOKEN, { force: true });
	await rm(GIT_HELPER, { force: true });
	if (!setup.gitToken) return;
	const repository = new URL(setup.repository);
	await writeFile(GIT_TOKEN, setup.gitToken, { mode: 0o600 });
	await chmod(GIT_TOKEN, 0o600);
	await writeFile(
		GIT_HELPER,
		`#!/bin/sh
[ "$1" = get ] || exit 0
while IFS= read -r line; do
 case "$line" in
  protocol=*) protocol=\${line#protocol=} ;;
  host=*) host=\${line#host=} ;;
  path=*) path=\${line#path=} ;;
 esac
done
[ "$protocol" = https ] && [ "$host" = ${quote(repository.host)} ] && [ "$path" = ${
			quote(repository.pathname.slice(1))
		} ] || exit 0
printf 'username=x-access-token\\npassword='
cat ${GIT_TOKEN}
printf '\\n'
`,
		{ mode: 0o700 },
	);
}

async function run(args: string[], cwd: string): Promise<string> {
	const result = await command(args.map(quote).join(" "), cwd);
	if (result.exitCode) throw new Error(result.output || `${args[0]} exited ${result.exitCode}`);
	return result.output.trim();
}

function connect(setup: Setup) {
	let stopped = false;
	let connected = false;
	let active = 0;
	let socket: WebSocket | undefined;
	let handle: ReturnType<typeof serve> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pinger: ReturnType<typeof setInterval> | undefined;
	let closing = Promise.resolve();
	let wait = 1000;

	const drop = async (current: WebSocket) => {
		if (socket !== current) return;
		socket = undefined;
		connected = false;
		clearTimeout(timer);
		clearInterval(pinger);
		current.close();
		const previous = handle;
		handle = undefined;
		closing = (async () => {
			await previous?.close();
			await cleanup();
		})();
		await closing;
		if (stopped) return;
		timer = setTimeout(open, wait);
		wait = Math.min(wait * 2, 30_000);
	};

	const open = () => {
		if (stopped) return;
		const current = new WebSocket(
			`${setup.hosted.replace(/^http/, "ws")}/channels/${setup.channel}/workspace`,
			{ headers: { authorization: `Bearer ${setup.secret}` } } as unknown as string[],
		);
		socket = current;
		timer = setTimeout(() => void drop(current), STALE);
		current.addEventListener("open", () => {
			if (stopped || socket !== current) return current.close();
			clearTimeout(timer);
			connected = true;
			wait = 1000;
			handle = serve(environment, (reply) => {
				if (current.readyState === WebSocket.OPEN) {
					current.send(redact(JSON.stringify(reply), setup));
				}
			});
			let missed = 0;
			const ping = () => {
				if (missed++ >= STALE / PING_INTERVAL) return void drop(current);
				current.send(PING);
			};
			current.addEventListener("message", ({ data }) => {
				if (socket !== current || !handle) return;
				if (data === PONG) {
					missed = 0;
					return;
				}
				const message = JSON.parse(String(data)) as WorkspaceMessage;
				if (!("call" in message) && !("cancel" in message)) return;
				active++;
				void handle(message).finally(() => active--);
			});
			ping();
			pinger = setInterval(ping, PING_INTERVAL);
		});
		current.addEventListener("close", () => void drop(current));
		current.addEventListener("error", () => void drop(current));
	};
	open();
	return {
		get connected() {
			return connected;
		},
		get active() {
			return active;
		},
		async close() {
			stopped = true;
			clearTimeout(timer);
			clearInterval(pinger);
			if (socket) await drop(socket);
			await closing;
		},
	};
}

async function disconnect(): Promise<void> {
	await link?.close();
	link = undefined;
	await cleanup();
}

function validate(input: Setup): Setup {
	const repository = new URL(input.repository);
	const hosted = new URL(input.hosted);
	if (repository.protocol !== "https:" || repository.username || repository.password) {
		throw new Error("Repository must be an HTTPS URL without credentials");
	}
	if (
		hosted.protocol !== "https:"
		&& !(hosted.protocol === "http:" && hosted.hostname === "localhost")
	) {
		throw new Error("Hosted service must use HTTPS (or localhost for development)");
	}
	if (hosted.username || hosted.password || hosted.search || hosted.hash) {
		throw new Error("Hosted service URL cannot contain credentials, a query, or a fragment");
	}
	if (!/^[a-z0-9-]{1,64}$/.test(input.channel)) throw new Error("Invalid channel ID");
	if (!input.secret || !input.owner?.name || !input.owner.email) {
		throw new Error("Setup requires a service secret and Git author name and email");
	}
	if (input.gitToken && /\s/.test(input.gitToken)) {
		throw new Error("Git token cannot contain whitespace");
	}
	if (repository.search || repository.hash) {
		throw new Error("Repository URL cannot contain a query or fragment");
	}
	const project = input.project;
	if (
		project !== undefined
		&& (project !== resolve(project) || project === "/" || project === WORKSPACE_ROOT
			|| project.startsWith(`${WORKSPACE_ROOT}/`))
	) {
		throw new Error("Project must be an absolute path outside the workspace");
	}
	for (const lane of input.lanes || []) {
		if (
			!project || lane.path !== resolve(lane.path)
			|| !lane.path.startsWith(`${project}/.lane/trees/`)
		) {
			throw new Error("Each lane must be in the project's .lane/trees");
		}
		if (!/^[\w.-]+(\/[\w.-]+)*$/.test(lane.branch) || (lane.base && /\s/.test(lane.base))) {
			throw new Error(`Invalid lane branch ${lane.branch}`);
		}
	}
	return {
		...input,
		repository: repository.href.replace(/\/$/, ""),
		hosted: hosted.href.replace(/\/$/, ""),
	};
}

/**
 * A moved channel's records name its old host's paths, so the clone answers to that project path
 * too. Lanes are added at their real paths, since checkpoints hold only the workspace and worktree
 * metadata keeps absolute paths.
 */
async function adopt(project: string, lanes: NonNullable<Setup["lanes"]>): Promise<void> {
	if (!existsSync(project)) {
		await mkdir(dirname(project), { recursive: true });
		await symlink(PROJECT_ROOT, project);
	}
	for (const lane of lanes) {
		const path = PROJECT_ROOT + lane.path.slice(project.length);
		if (existsSync(path)) continue;
		const remote = `refs/remotes/origin/${lane.branch}`;
		await run(["git", "fetch", "origin", `+refs/heads/${lane.branch}:${remote}`], PROJECT_ROOT);
		await run(["git", "worktree", "add", "-B", lane.branch, path, remote], PROJECT_ROOT);
		await run(
			["git", "branch", `--set-upstream-to=origin/${lane.branch}`, lane.branch],
			PROJECT_ROOT,
		);
		if (lane.base) {
			await run(["git", "config", `lane.${lane.branch}.base`, lane.base], PROJECT_ROOT);
		}
	}
}

async function setup(input: Setup): Promise<void> {
	const next = validate(input);
	await disconnect();
	configuration = next;
	await credentials(next);
	await mkdir(WORKSPACE_ROOT, { recursive: true });
	if (!existsSync(PROJECT_ROOT)) {
		await run(["git", "clone", "--", next.repository, PROJECT_ROOT], WORKSPACE_ROOT);
	} else {
		const origin = await run(["git", "remote", "get-url", "origin"], PROJECT_ROOT);
		if (origin !== next.repository) throw new Error("Existing clone belongs to another repository");
	}
	await run(["git", "config", "user.name", next.owner.name], PROJECT_ROOT);
	await run(["git", "config", "user.email", next.owner.email], PROJECT_ROOT);
	await run(["lane", "install", "hooks"], PROJECT_ROOT);
	if (next.project) await adopt(next.project, next.lanes || []);
	link = connect(next);
}

async function status() {
	const repository = existsSync(PROJECT_ROOT)
		? await command("git --no-optional-locks status --short --branch", PROJECT_ROOT)
		: undefined;
	return {
		channel: configuration?.channel,
		repository: configuration?.repository,
		project: PROJECT_ROOT,
		connected: link?.connected || false,
		active: link?.active || 0,
		git: repository,
		capabilities: { files: true, exec: true, desktop: false, browser: false },
	};
}

async function route(request: Request, path: string): Promise<Response> {
	if (path === "/setup" && request.method === "POST") {
		await setup(await request.json() as Setup);
		return Response.json(await status());
	}
	if (path === "/disconnect" && request.method === "POST") {
		await disconnect();
		return Response.json({ connected: false });
	}
	if (path === "/exec" && request.method === "POST") {
		if (!configuration) {
			return Response.json({ error: "Set up the workspace first" }, { status: 409 });
		}
		const body = await request.json() as { command: string; cwd?: string };
		if (typeof body.command !== "string" || !body.command.trim()) {
			return Response.json({ error: "Command is required" }, { status: 400 });
		}
		return Response.json(
			await command(body.command, resolve(PROJECT_ROOT, body.cwd || "."), request.signal),
		);
	}
	if (path === "/checkpoint" && request.method === "GET") {
		if (link) return Response.json({ error: "Disconnect before checkpointing" }, { status: 409 });
		await assertQuiescent();
		return new Response(new Uint8Array(await checkpoint()).buffer, {
			headers: { "content-type": "application/octet-stream" },
		});
	}
	if (path === "/restore" && request.method === "POST") {
		if (link) return Response.json({ error: "Disconnect before restoring" }, { status: 409 });
		await restore(new Uint8Array(await request.arrayBuffer()));
		return Response.json({ restored: true });
	}
	return new Response("Not found", { status: 404 });
}

await initializeQuiescence();

const server = Bun.serve({
	port: 8080,
	hostname: "0.0.0.0",
	idleTimeout: 255,
	maxRequestBodySize: MAX_CHECKPOINT_BYTES,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/health") return Response.json({ ok: true });
		try {
			if (path === "/status" && request.method === "GET") return Response.json(await status());
			if (operation) {
				return Response.json({ error: "Workspace operation in progress" }, { status: 409 });
			}
			operation = true;
			try {
				return await route(request, path);
			} finally {
				operation = false;
			}
		} catch (error) {
			return Response.json({ error: redact((error as Error).message) }, { status: 400 });
		}
	},
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, async () => {
		await disconnect();
		await server.stop(true);
		process.exit(0);
	});
}
