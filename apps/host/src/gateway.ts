import { existsSync, mkdirSync, watch } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import type { Server, ServerWebSocket } from "bun";

import * as auth from "./auth";
import * as catalog from "./catalog";
import { Connection } from "./client";
import { config } from "./config";
import { diagnostics } from "./diagnostics";
import * as directory from "./directory";
import { GatewayClient, type Watch } from "./gateway-client";
import * as github from "./github";
import { seal } from "./keys";
import { failure, log, open as openLog } from "./log";
import { move, targets } from "./move";
import {
	archive,
	archiveInactive,
	isRunning,
	isWorkerAlive,
	models,
	project,
	remove,
} from "./manage";
import * as peers from "./peers";
import * as projects from "./projects";
import {
	HOST_PROTOCOL,
	type HostEnvelope,
	type HostFrame,
	type HostInfo,
	type HostRequest,
	type Listing,
	type People,
} from "./protocol";
import { type Machine, self, whois } from "./tailnet";
import { checkKey, removeKey, setKey, setModel, settings } from "./settings";
import { resume, shutdown } from "./shutdown";
import * as terminals from "./terminals";
import * as web from "./web";
import * as windows from "./windows";
import * as workspace from "./workspace";

type Client = {
	/** The participant this socket speaks for: the owner on loopback, a verified login on the tailnet. */
	user: string;
	/** Arrived over the tailnet. Peers act only on this host's channels, and never as its owner. */
	peer: boolean;
	local: boolean;
	channels: Map<string, Promise<Connection>>;
	/** This client's connections to peer hosts, opened when it first uses one of their channels. */
	remotes: Map<string, GatewayClient>;
	/** Detaches this client from the terminals it opened; the shells keep running. */
	terminals: Map<string, () => void>;
};

let name = hostname();
let closing = false;
let updating = false;
let update = 0;
let suspending: Promise<unknown> | undefined;
const pending = new Set<Promise<unknown>>();
/** Deleting kills the worker first; the watches that ends must not start it again. */
const deleting = new Set<string>();

function local(): Listing[] {
	return catalog.list().map((record) => {
		const state = record.archived ? "archived" : isRunning(record.id) ? "running" : "dormant";
		const {
			id,
			name: channel,
			prefix,
			summary,
			revision,
			owner,
			project,
			model,
			created,
			active,
			ran,
			hosted,
		} = record;
		const listing: Listing = {
			id,
			host: name,
			name: channel,
			prefix,
			summary,
			revision,
			owner,
			project,
			model,
			created,
			state,
			busy: state === "running" && !!record.busy && (!hosted || workspace.isConnected(id)),
		};
		if (active) listing.active = active;
		if (ran) listing.ran = ran;
		const { root, repo } = projects.checkout(project);
		listing.root = root;
		if (repo) listing.repo = repo;
		if (hosted) listing.hosted = hosted;
		return listing;
	});
}

/** Channels only the directory or a peer's last answer knows: their host is unreachable, unless they are hosted. */
function listed(seen: Set<string>): Listing[] {
	return [...directory.read().channels, ...peers.unreachable()]
		.filter((value) => {
			if (seen.has(value.id) || value.host === name) return false;
			seen.add(value.id);
			return true;
		})
		.map((value) =>
			Object.assign({}, value, {
				state: value.state === "archived" || value.hosted ? value.state : "offline" as const,
				// The directory is a cache, not a live connection, even for hosted channels.
				busy: false,
			})
		);
}

function listings(client: Client, own = local()): Listing[] {
	if (client.peer) return own;
	const reachable = [...own, ...peers.listings()];
	return [...reachable, ...listed(new Set(reachable.map((value) => value.id)))];
}

const sockets = new Set<ServerWebSocket<Client>>();

/**
 * This host's channels changed. Peers receive only that, so their own broadcasts never echo back:
 * two hosts relaying each other's frames would loop forever, starving both event loops.
 */
function broadcast() {
	const own = local();
	const frame = JSON.stringify({ channels: own } satisfies HostFrame);
	for (const socket of sockets) if (socket.data.peer) socket.send(frame);
	ownersChanged(own);
}

/** Peer and directory listings reach only the owner's app; peers never see them. */
function ownersChanged(own?: Listing[]) {
	let frame: string | undefined;
	for (const socket of sockets) {
		if (socket.data.peer) continue;
		frame ??= JSON.stringify(
			{ channels: listings(socket.data, own || local()) } satisfies HostFrame,
		);
		socket.send(frame);
	}
	peopleChanged();
}

/** Fresher sources win: the directory, then reachable peers, then this host's own owner. */
function people(): People {
	const known: People = {};
	for (const host of directory.read().hosts) if (host.github) known[host.login] = host.github;
	Object.assign(known, peers.people());
	const own = github.login(peopleChanged);
	if (own) known[catalog.user] = own;
	return known;
}

let sent = "";

function peopleChanged(): void {
	const frame = JSON.stringify({ people: people() } satisfies HostFrame);
	if (frame === sent) return;
	sent = frame;
	for (const socket of sockets) if (!socket.data.peer) socket.send(frame);
}

function projectsChanged(): void {
	const frame = JSON.stringify({ projects: projects.list() } satisfies HostFrame);
	for (const socket of sockets) if (!socket.data.peer) socket.send(frame);
}

function settingsChanged(): void {
	for (const socket of sockets) {
		if (!socket.data.peer) socket.send(JSON.stringify({ settings: true } satisfies HostFrame));
	}
}

function connection(client: Client, channel: string, hosted?: string): Promise<Connection> {
	if (deleting.has(channel)) return Promise.reject(new Error("The channel is being deleted"));
	let open = client.channels.get(channel);
	if (!open) {
		open = hosted ? Connection.hosted(hosted, channel) : Connection.open(channel);
		client.channels.set(channel, open);
		// A released connection can close after its replacement opened; never drop the replacement.
		const drop = () => {
			if (client.channels.get(channel) === open) client.channels.delete(channel);
		};
		open.then((connection) => connection.closed.then(drop), drop);
	}
	return open;
}

async function remote(client: Client, host: string): Promise<GatewayClient> {
	let open = client.remotes.get(host);
	if (!open) {
		const machine = peers.machine(host);
		if (!machine) throw new Error(`${host} is not reachable`);
		open = new GatewayClient(peers.url(machine));
		client.remotes.set(host, open);
	}
	for (let waited = 0; open.status !== "open"; waited += 50) {
		if (waited >= 5000) throw new Error(`${host} is not reachable`);
		await Bun.sleep(50);
	}
	return open;
}

const owned = new Set<HostRequest["op"]>(["archive", "archive-inactive", "delete"]);
const windowOps = new Set<HostRequest["op"]>(["window", "windows", "tab-rename", "tab-result"]);
const moveOps = new Set<HostRequest["op"]>(["move-targets", "move"]);
const localOps = new Set<HostRequest["op"]>([
	"projects",
	"project-open",
	"project-init",
	"project-clone",
	"github-list",
	"github-detail",
	"github-files",
	"github-pull",
	"settings",
	"diagnostics",
	"key-set",
	"key-check",
	"key-remove",
	"preferences",
	"update-prepare",
	"update-cancel",
	// A terminal is a shell as this host's user, so only its owner opens one.
	"terminal",
	"terminal-input",
	"terminal-resize",
	"terminal-close",
]);

async function handle(
	socket: ServerWebSocket<Client>,
	request: HostRequest,
	send: (frame: HostFrame) => void,
	id: number,
	trace: string,
): Promise<unknown> {
	if (closing) throw new Error("Ace Helper is shutting down");
	const client = socket.data;
	if (windowOps.has(request.op) && (!client.local || client.user !== catalog.user)) {
		throw new Error("Tabs are only available through this host's authenticated local gateway");
	}
	if (moveOps.has(request.op) && (!client.local || client.user !== catalog.user)) {
		throw new Error("Only this host's owner can move channels, from its local app");
	}
	if (localOps.has(request.op) && (client.peer || client.user !== catalog.user)) {
		throw new Error("This action is only available from this host's local app");
	}
	if (!client.local && (request.op === "update-prepare" || request.op === "update-cancel")) {
		throw new Error("Desktop updates are only available from this host's local app");
	}
	if (updating && request.op !== "update-cancel") {
		throw new Error("Ace is pausing this machine's channels to install an update");
	}
	// A channel runs where it was created, so even its owner creates from that machine.
	if (client.peer && request.op === "create") {
		throw new Error("Create channels from the host that will run them");
	}
	if (owned.has(request.op) && client.user !== catalog.user) {
		throw new Error("Only this host's owner can do that");
	}
	switch (request.op) {
		case "window":
			return windows.publish(socket, request.value);
		case "windows":
			return windows.list();
		case "tab-rename":
			return windows.rename(request);
		case "tab-result":
			return windows.result(socket, request.call, request.result);
		case "update-prepare": {
			if (!config.helper) throw new Error("Only Ace Helper can prepare a desktop update");
			const current = ++update;
			updating = true;
			// handle() starts before this request enters pending, so it cannot await itself.
			await Promise.allSettled(pending);
			// A timed-out desktop request can be canceled while an older request is still draining.
			if (current !== update) throw new Error("The update was canceled");
			const stopping = Promise.allSettled([workspace.close(), shutdown(), terminals.closeAll()]);
			suspending = stopping;
			try {
				const results = await stopping;
				const errors = results.filter((result) => result.status === "rejected");
				if (errors.length) {
					throw new AggregateError(
						errors.map((result) => result.reason),
						"Some work could not be paused for the update",
					);
				}
				if (current !== update) throw new Error("The update was canceled");
			} finally {
				suspending = undefined;
			}
			return { ready: true };
		}
		case "update-cancel":
			if (updating) {
				update++;
				if (suspending) await Promise.allSettled([suspending]);
				await resume();
				workspace.sync();
				updating = false;
			}
			return;
		case "hello":
			return { user: client.user, host: name, github: github.login(peopleChanged) };
		case "channels":
			return listings(client);
		case "projects":
			return projects.list();
		case "project-open": {
			const project = projects.open(request.path);
			projectsChanged();
			return project;
		}
		case "project-init": {
			const project = projects.init(request.path);
			projectsChanged();
			return project;
		}
		case "project-clone": {
			const project = await projects.setup(request.repo, request.path);
			projectsChanged();
			return project;
		}
		case "project-repo": {
			if (request.host && request.host !== name && !client.peer) {
				return (await remote(client, request.host)).request(
					{
						op: "project-repo",
						project: request.project,
					},
					undefined,
					trace,
				);
			}
			const known = client.peer
				? catalog.list().some((channel) =>
					projects.checkout(channel.project).root === request.project
				)
				: projects.list().some((project) => project.path === request.project);
			if (!known) throw new Error("Open this project in Ace first");
			return github.project(request.project);
		}
		case "github-list":
			return github.list(request);
		case "github-detail":
			return github.detail(request);
		case "github-files":
			return github.files(request.repo, request.number);
		case "github-pull":
			return github.pull(request.repo, request.branch);
		case "settings":
			return settings();
		case "diagnostics":
			return diagnostics();
		case "key-set":
			await setKey(request.provider, request.value);
			return settingsChanged();
		case "key-check":
			return checkKey(request.provider);
		case "key-remove":
			await removeKey(request.provider);
			return settingsChanged();
		case "preferences":
			await setModel(request.model);
			return settingsChanged();
		case "models":
			if (request.host && request.host !== name && !client.peer) {
				return (await remote(client, request.host)).request({ op: "models" });
			}
			return models();
		case "create": {
			const record = catalog.create(
				project(request.project),
				request.model,
				request.name || undefined,
			);
			broadcast();
			return record;
		}
		case "archive":
			if (request.archived) terminals.closeChannel(request.channel);
			await archive(request.channel, request.archived);
			return broadcast();
		case "archive-inactive": {
			const archived = await archiveInactive(request.project);
			for (const channel of archived) terminals.closeChannel(channel);
			broadcast();
			return archived.length;
		}
		case "move-targets":
			return catalog.owns(request.channel) ? targets(request.channel) : [];
		case "move":
			if (!catalog.owns(request.channel)) {
				throw new Error("Move channels from the host that runs them");
			}
			await move(request.channel, request.target);
			return broadcast();
		case "delete":
			terminals.closeChannel(request.channel);
			deleting.add(request.channel);
			try {
				await remove(request.channel);
			} finally {
				deleting.delete(request.channel);
			}
			return broadcast();
		case "terminal": {
			if (!catalog.owns(request.channel)) throw new Error("Terminals open on the channel's host");
			const { opened, attach } = await terminals.open(request);
			client.terminals.get(opened.terminal)?.();
			// After the reply, which is sent once this returns and its microtasks settle.
			setTimeout(() => {
				if (socket.readyState === 1) client.terminals.set(opened.terminal, attach(send));
			});
			return opened;
		}
		case "terminal-input":
			return terminals.input(request.terminal, request.data);
		case "terminal-resize":
			return terminals.resize(request.terminal, request.cols, request.rows);
		case "terminal-close":
			client.terminals.delete(request.terminal);
			return terminals.close(request.terminal);
		case "channel": {
			// Only a watch streams; other requests must not leave watchers behind in relays.
			const watch: Watch | undefined = request.request.op === "watch"
				? {
					event: (event) => send({ id, event }),
					// After the accepted reply, a failure for the same id tells the client its watch ended.
					closed: (error) => {
						log("debug", "gateway.watch.closed", {
							trace,
							user: client.user,
							peer: client.peer,
							channel: request.channel,
							error,
						});
						send({ id, ok: false, error });
					},
				}
				: undefined;
			if (catalog.owns(request.channel)) {
				if (request.request.op === "kill") {
					if (client.user !== catalog.user) throw new Error("Only the channel's owner can kill it");
					terminals.closeChannel(request.channel);
				}
				const forwarded = "author" in request.request
					? { ...request.request, author: client.user }
					: request.request;
				const target = await connection(client, request.channel);
				return target.request(forwarded, watch, trace);
			}
			const machine = !client.peer && peers.find(request.channel);
			const hosted = !client.peer && !machine
				&& directory.read().channels.find((value) => value.id === request.channel && value.hosted);
			if (hosted) {
				if (request.request.op === "kill" && client.user !== hosted.owner) {
					throw new Error("Only the channel's owner can kill it");
				}
				const forwarded = "author" in request.request
					? { ...request.request, author: client.user }
					: request.request;
				const target = await connection(client, request.channel, hosted.hosted);
				return target.request(forwarded, watch, trace);
			}
			if (!machine) throw new Error("No reachable host runs that channel");
			const target = await remote(client, machine.name);
			return target.channel(request.channel, request.request, watch, trace);
		}
		case "release": {
			const open = client.channels.get(request.channel);
			client.channels.delete(request.channel);
			if (open) return void (await open).close();
			const machine = peers.find(request.channel);
			const target = machine && client.remotes.get(machine.name);
			if (target?.status === "open") await target.request(request);
			return;
		}
	}
}

function websocket(): Bun.WebSocketHandler<Client> {
	return {
		open(socket) {
			sockets.add(socket);
			log("info", "gateway.open", { user: socket.data.user, peer: socket.data.peer });
			if (!socket.data.peer) {
				socket.send(JSON.stringify({ projects: projects.list() } satisfies HostFrame));
				socket.send(JSON.stringify({ people: people() } satisfies HostFrame));
			}
		},
		async message(socket, raw) {
			const { id, trace: given, ...request } = JSON.parse(String(raw)) as HostEnvelope;
			// A peer host's trace continues here, so one request reads across both machines' logs.
			const trace = given || crypto.randomUUID().slice(0, 8);
			const send = (frame: HostFrame) =>
				socket.readyState === 1 && socket.send(JSON.stringify(frame));
			const start = Date.now();
			const fields = {
				trace,
				user: socket.data.user,
				peer: socket.data.peer,
				op: request.op,
				...("channel" in request ? { channel: request.channel } : {}),
				...(request.op === "channel" ? { request: request.request.op } : {}),
			};
			// Listing and watching repeat constantly; everything else is a deliberate action.
			const quiet = request.op === "channels" || request.op === "projects"
				|| request.op === "window" || request.op === "windows" || request.op === "tab-result"
				|| request.op === "hello" || request.op === "models"
				|| request.op === "release" || request.op === "terminal-input"
				|| request.op === "terminal-resize"
				|| (request.op === "channel" && ["watch", "info", "models"].includes(request.request.op));
			const handling = handle(socket, request, send, id, trace);
			pending.add(handling);
			try {
				const value = await handling;
				log(quiet ? "debug" : "info", "gateway.request", { ...fields, ms: Date.now() - start });
				send({ id, ok: true, value: value ?? null });
			} catch (error) {
				log("warn", "gateway.failed", { ...fields, ms: Date.now() - start, ...failure(error) });
				send({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
			} finally {
				pending.delete(handling);
			}
		},
		close(socket, code) {
			sockets.delete(socket);
			windows.drop(socket);
			log("info", "gateway.close", { user: socket.data.user, peer: socket.data.peer, code });
			for (const open of socket.data.channels.values()) {
				open.then((connection) => connection.close(), () => {});
			}
			for (const remote of socket.data.remotes.values()) remote.close();
			for (const detach of socket.data.terminals.values()) detach();
		},
	};
}

function client(user: string, peer: boolean, local = false): Client {
	return { user, peer, local, channels: new Map(), remotes: new Map(), terminals: new Map() };
}

async function serveApp(url: URL): Promise<Response> {
	const dir = config.app;
	if (!existsSync(dir)) {
		return new Response("The app is not built; run bun app build", { status: 404 });
	}
	const file = Bun.file(join(dir, url.pathname));
	const headers = {
		"Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
	};
	if (url.pathname !== "/" && !url.pathname.includes("..") && await file.exists()) {
		return new Response(file, { headers });
	}
	return new Response(Bun.file(join(dir, "index.html")), { headers });
}

/** The owner's listener: loopback only, serving the app. */
function owner(port: number): Server<Client> {
	const access = auth.owner(port);
	return Bun.serve<Client>({
		port,
		hostname: "127.0.0.1",
		async fetch(request, server) {
			if (!access.accepts(request)) return new Response("Forbidden", { status: 403 });
			const url = new URL(request.url);
			if (url.pathname === "/health") {
				const challenge = request.headers.get("x-ace-challenge");
				if (challenge && !/^[a-f0-9]{64}$/.test(challenge)) {
					return new Response("Bad challenge", { status: 400 });
				}
				const info: HostInfo = {
					app: "ace",
					protocol: HOST_PROTOCOL,
					home: catalog.home,
					pid: process.pid,
					helper: config.helper,
				};
				return Response.json(info, {
					headers: challenge ? { "x-ace-proof": access.proof(info, challenge) } : undefined,
				});
			}
			if (url.pathname === "/ws") {
				if (!access.authorizes(request)) return new Response("Unauthorized", { status: 401 });
				const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map((value) =>
					value.trim()
				);
				return server.upgrade(request, {
						data: client(catalog.user, false, true),
						headers: {
							"set-cookie": access.cookie,
							...(protocols?.includes("ace") ? { "sec-websocket-protocol": "ace" } : {}),
						},
					})
					? undefined
					: new Response("Upgrade failed", { status: 400 });
			}
			return serveApp(url);
		},
		websocket: websocket(),
	});
}

/**
 * The team's listener on this machine's tailnet address. Tailscale names the person behind each
 * connection. Sockets without an Origin are peer hosts. Browser sockets are the owner's own
 * devices, and only from a page this host or the configured web app served (see web.ts).
 */
function team(machine: Machine, listener: web.Listener, tls?: Bun.TLSOptions): Server<Client> {
	const hosts = web.hosts(machine, listener);
	return Bun.serve<Client>({
		port: listener.port,
		hostname: machine.address,
		...(tls ? { tls } : {}),
		async fetch(request, server) {
			const url = new URL(request.url);
			const origin = request.headers.get("origin");
			if (url.pathname !== "/ws") {
				if (request.method !== "GET" || !hosts.has(request.headers.get("host") ?? "")) {
					return new Response("Not found", { status: 404 });
				}
				return serveApp(url);
			}
			if (origin === null ? listener.secure : !web.origins(machine, listener).has(origin)) {
				return new Response("Forbidden", { status: 403 });
			}
			const ip = server.requestIP(request);
			if (!ip) return new Response("Forbidden", { status: 403 });
			let user: string;
			try {
				user = await whois(ip.address, ip.port);
			} catch (error) {
				log("warn", "gateway.whois", { address: ip.address, ...failure(error) });
				return new Response("Forbidden", { status: 403 });
			}
			const browser = origin !== null;
			if (browser && user !== catalog.user) {
				log("warn", "gateway.browser.refused", { user, origin });
				return new Response("Open Ace from your own host", { status: 403 });
			}
			return server.upgrade(request, { data: client(user, !browser) })
				? undefined
				: new Response("Upgrade failed", { status: 400 });
		},
		websocket: websocket(),
	});
}

export async function serve(port: number): Promise<never> {
	config.port = port;
	// Channel workers and agent shells reach this listener for the owner's windows.
	process.env.ACE_PORT = String(port);
	// Hosted channels run tools in this process.
	seal();
	openLog("host");
	await resume();
	const server = owner(port);
	log("info", "host.start", { port: server.port, user: catalog.user, bun: Bun.version });
	const servers = [server];
	const cleanup: (() => void)[] = [];
	async function stop() {
		if (closing) return;
		closing = true;
		log("info", "host.stop", { pending: pending.size });
		for (const close of cleanup) close();
		await Promise.allSettled(servers.map((server) => server.stop(true)));
		await Promise.allSettled(pending);
		const results = await Promise.allSettled([workspace.close(), shutdown(), terminals.closeAll()]);
		for (const result of results) {
			if (result.status === "rejected") {
				log("error", "host.shutdown.failed", failure(result.reason));
			}
		}
		process.exit(results.some((result) => result.status === "rejected") ? 1 : 0);
	}
	process.on("SIGTERM", () => void stop());
	process.on("SIGINT", () => void stop());
	console.log(`Ace on http://${server.hostname}:${server.port}`);
	const machine = await self();
	if (closing) return new Promise(() => {});
	if (machine) name = machine.name;
	const address = machine ? { address: machine.address } : {};
	const publish = directory.watch(
		() => ({ name, login: catalog.user, github: github.login(peopleChanged), ...address }),
		local,
		() => ownersChanged(),
	);
	log("info", "host.tailnet", machine ? { name, address: machine.address } : { tailscale: false });
	cleanup.push(publish.stop);
	if (machine) {
		servers.push(team(machine, { port, secure: false }));
		console.log(`Sharing with the tailnet on ${machine.address}:${port} as ${machine.login}`);
		console.log(`Your devices can open http://${machine.dns}:${port}`);
		cleanup.push(peers.watch(() => ownersChanged()));
		const tls = await web.tls(machine);
		if (tls && !closing) {
			const listener = { port: config.webPort ?? port + 1000, secure: true };
			servers.push(team(machine, listener, tls));
			console.log(`and https://${machine.dns}:${listener.port}`);
		}
	} else {
		console.log("Tailscale is not running; channels stay on this machine");
	}
	mkdirSync(join(catalog.home, "channels"), { recursive: true });
	// Workers create and remove their sockets; tell clients when a channel starts or retires.
	const watcher = watch(join(catalog.home, "channels"), { recursive: true }, (_, file) => {
		if (closing || updating) return;
		if (file?.endsWith("channel.sock") || file?.endsWith("channel.json")) broadcast();
		if (file?.endsWith("channel.json")) {
			projectsChanged();
			workspace.sync();
			void publish.sync();
		}
	});
	cleanup.push(() => watcher.close());
	// A crashed worker leaves its socket and projection behind without a filesystem event.
	// Probe only process liveness: sidebar observation must never attach to or wake a worker.
	let crashed = new Set<string>();
	const liveness = setInterval(() => {
		if (closing || updating) return;
		const current = new Set<string>();
		for (const record of catalog.list()) {
			if (!record.hosted && record.busy && !isWorkerAlive(record.id)) current.add(record.id);
		}
		// Do not overwrite a replacement worker's projection after observing its predecessor die.
		if (current.size !== crashed.size || [...current].some((id) => !crashed.has(id))) broadcast();
		crashed = current;
	}, 5000);
	cleanup.push(() => clearInterval(liveness));
	workspace.sync();
	return new Promise(() => {});
}
