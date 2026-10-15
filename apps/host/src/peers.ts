/** Other hosts on the tailnet: found through Tailscale, reached on their gateway's tailnet listener. */
import { isIP } from "node:net";

import { config } from "./config";
import { GatewayClient } from "./gateway-client";
import { log } from "./log";
import type { Hello, Listing, People } from "./protocol";
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
		client.onOpen = () => {
			client.request<Hello>({ op: "hello" }).then((hello) => {
				// A freshly started peer answers before `gh` has told it its owner's login.
				if (!hello.github || named[machine.login] === hello.github) return;
				named[machine.login] = hello.github;
				emit();
			}, () => {});
		};
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

/** Every reachable peer's channels. */
export function listings(): Listing[] {
	return [...hosts.values()].flatMap(({ client }) =>
		client.status === "open" ? client.channels : []
	);
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

export function machine(name: string): Machine | undefined {
	return hosts.get(name)?.machine;
}
