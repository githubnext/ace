/** Other hosts on the tailnet: found through Tailscale, reached on their gateway's tailnet listener. */
import { isIP } from "node:net";

import { config } from "./config";
import * as directory from "./directory";
import { GatewayClient } from "./gateway-client";
import { log } from "./log";
import type { Hello, Invite, Listing, Member, People, TeamPeer } from "./protocol";
import { type Machine, peers } from "./tailnet";

/** Hosts serve their tailnet listener on the same port unless told otherwise. */
const port = () => config.peerPort || config.port;

export function url(machine: Machine): string {
	const address = isIP(machine.address) === 6 ? `[${machine.address}]` : machine.address;
	return `ws://${address}:${port()}/ws`;
}

type Peer = { machine: Machine; client: GatewayClient };

/** One listing connection per online peer, kept only while the peer answers. */
const hosts = new Map<string, Peer>();
const listeners = new Set<() => void>();
/** Each peer's channels as it last answered, listed as offline while the peer is unreachable. */
const remembered = new Map<string, Listing[]>();
/** Relays per peer that stopped answering a request or watch, while their sockets stay open. */
const stalled = new Map<string, number>();
/** Peer owners' GitHub logins by Tailscale login, from their last hello, so remembered channels keep their owner's name and avatar. */
const named: People = {};

function emit() {
	for (const listener of listeners) listener();
}

async function discover(signal: AbortSignal) {
	const online = new Map((await peers()).map((machine) => [machine.name, machine]));
	if (signal.aborted) return;
	for (const [name, host] of hosts) {
		if (online.get(name)?.address === host.machine.address) continue;
		host.client.close();
		hosts.delete(name);
		log("info", "peer.gone", { peer: name });
		emit();
	}
	for (const [name, machine] of online) {
		if (hosts.has(name)) continue;
		const client = new GatewayClient(url(machine));
		const host: Peer = { machine, client };
		client.onOpen = () => greet(client, machine);
		let status = client.status;
		client.subscribe(() => {
			if (client.status !== status) {
				log(client.status === "open" ? "info" : "debug", "peer.status", {
					peer: name,
					address: machine.address,
					from: status,
					to: client.status,
				});
				status = client.status;
			}
			if (client.status === "open") remembered.set(name, client.channels);
			emit();
		});
		hosts.set(name, host);
	}
	// A teammate can start a directory after this host first greeted them.
	if (directory.isChosen()) return;
	for (const { client, machine } of hosts.values()) {
		if (client.status === "open") greet(client, machine);
	}
}

function greet(client: GatewayClient, machine: Machine) {
	client.request<Hello>({ op: "hello" }).then((hello) => {
		if (hello.directory) void directory.adopt(hello.directory);
		// A freshly started peer answers before `gh` has told it its owner's login.
		if (!hello.github || named[machine.login] === hello.github) return;
		named[machine.login] = hello.github;
		emit();
	}, () => {});
}

/** Start looking for peers; `onChange` runs when any peer's channels or reachability change. */
export function watch(onChange: () => void) {
	const controller = new AbortController();
	listeners.add(onChange);
	void discover(controller.signal);
	const interval = setInterval(() => void discover(controller.signal), 15_000);
	return () => {
		controller.abort();
		clearInterval(interval);
		listeners.delete(onChange);
		for (const { client } of hosts.values()) client.close();
		hosts.clear();
	};
}

/**
 * A connection relaying one of this host's clients to a peer. The listing connection is idle, so
 * only a relay with a request or watch waiting notices the peer stop answering, as while it is
 * suspended; its channels are then listed `stalled` until any relay to it hears from it again.
 */
export function relay(machine: Machine): GatewayClient {
	const client = new GatewayClient(url(machine));
	let quiet = false;
	client.subscribe(() => {
		if (client.stalled === quiet) return;
		quiet = client.stalled;
		const count = (stalled.get(machine.name) || 0) + (quiet ? 1 : -1);
		if (count) stalled.set(machine.name, count);
		else stalled.delete(machine.name);
		log("info", "peer.stalled", { peer: machine.name, stalled: quiet });
		emit();
	});
	return client;
}

/** Every reachable peer's channels. */
export function listings(): Listing[] {
	return [...hosts.values()].flatMap(({ machine, client }) => {
		if (client.status !== "open") return [];
		if (!stalled.has(machine.name)) return client.channels;
		// A hosted channel is reached at its service, never through the peer.
		return client.channels.map((channel) =>
			channel.hosted ? channel : { ...channel, stalled: true }
		);
	});
}

/** Channels of peers that answered before but are unreachable now. */
export function unreachable(): Listing[] {
	return [...remembered].flatMap(([name, channels]) =>
		hosts.get(name)?.client.status === "open" ? [] : channels
	);
}

/** Peers' owners' GitHub logins as they last answered, reachable or not. */
export function people(): People {
	return named;
}

/** The peer that runs a channel, if it is reachable. */
export function find(channel: string): Machine | undefined {
	for (const { machine, client } of hosts.values()) {
		if (client.status === "open" && client.channels.some((value) => value.id === channel)) {
			return machine;
		}
	}
}

/** Peers whose hosts are in a team, asked now: a peer may have joined since it first answered. */
export async function teams(): Promise<TeamPeer[]> {
	const found = await Promise.all(
		[...hosts.values()].map(async ({ machine, client }) => {
			if (client.status !== "open" || stalled.has(machine.name)) return;
			const hello = await Promise.race([
				client.request<Hello>({ op: "hello" }),
				Bun.sleep(3000),
			]).catch(() => undefined);
			if (!hello?.team) return;
			const peer: TeamPeer = { host: machine.name, login: machine.login, team: hello.team };
			const github = hello.github || named[machine.login];
			if (github) peer.github = github;
			return peer;
		}),
	);
	return found.filter((peer) => !!peer);
}

/** Hosts running Ace on the tailnet now. */
export function online(): Member[] {
	return [...hosts.values()].flatMap(({ machine, client }) => {
		if (client.status !== "open") return [];
		const github = named[machine.login];
		return [{
			host: machine.name,
			login: machine.login,
			...(github ? { github } : {}),
			online: true,
		}];
	});
}

/** Waits for the peer's owner to approve; see asks.ts. */
export function ask(name: string): Promise<Invite> {
	const client = hosts.get(name)?.client;
	if (client?.status !== "open") throw new Error(`${name} isn't reachable on the tailnet`);
	return client.request<Invite>({ op: "team-request" });
}

export function machine(name: string): Machine | undefined {
	return hosts.get(name)?.machine;
}

/**
 * Peers read shares from the directory, which a lobby can't announce to someone just given
 * access, so the host that changed them tells every reachable peer to read it again.
 */
export function sharesChanged(): void {
	for (const { client } of hosts.values()) {
		if (client.status === "open") client.request({ op: "shares-changed" }).catch(() => {});
	}
}
