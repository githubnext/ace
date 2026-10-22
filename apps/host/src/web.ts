/**
 * The owner's other devices (a phone, a laptop away from this one) open Ace in a browser over the
 * tailnet. Tailscale names the person behind each connection; only this host's owner is served,
 * and only pages this host or the web app served may open a socket, so another site in the
 * owner's browser cannot drive the host. The web app is this host's own setting, or else the one
 * the team's directory names, so teammates who joined the directory need no setup of their own.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as catalog from "./catalog";
import * as directory from "./directory";
import { failure, log } from "./log";
import { certificate, type Machine } from "./tailnet";

const file = join(catalog.home, "web.json");

/** The deployed web app's origin, e.g. https://ace-app.example.workers.dev. */
export function app(): string | undefined {
	if (process.env.ACE_WEB_APP) return new URL(process.env.ACE_WEB_APP).origin;
	if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).app;
	const team = directory.read().app;
	if (team?.startsWith("https://")) return new URL(team).origin;
}

export function configure(value: string | undefined): void {
	if (!value) return rmSync(file, { force: true });
	const url = new URL(value);
	if (url.protocol !== "https:") throw new Error("The web app must be served over HTTPS");
	writeFileSync(file, JSON.stringify({ app: url.origin }));
}

/** HTTPS needs the tailnet's certificates; without them browsers use plain HTTP over WireGuard. */
export async function tls(machine: Machine): Promise<{ cert: string; key: string } | undefined> {
	const dir = join(catalog.home, "tls");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		const files = await certificate(machine.dns, dir);
		return { cert: readFileSync(files.cert, "utf8"), key: readFileSync(files.key, "utf8") };
	} catch (error) {
		log("info", "web.tls.unavailable", failure(error));
	}
}

export type Listener = { port: number; secure: boolean };

/** The HTTPS address the owner's phone opens, once that listener is up. */
export let address: string | undefined;

/** The tailnet's plain HTTP address, which WireGuard encrypts but browsers treat as insecure. */
export let plain: string | undefined;

export function served(machine: Machine, listener: Listener): void {
	if (listener.secure) address = `https://${machine.dns}:${listener.port}`;
	else plain = `http://${machine.dns}:${listener.port}`;
}

/** Names this host answers to on the tailnet; anything else is DNS rebinding. */
export function hosts(machine: Machine, listener: Listener): Set<string> {
	const names = listener.secure ? [machine.dns] : [machine.dns, machine.name, machine.address];
	return new Set(names.map((name) => `${name}:${listener.port}`));
}

export function origins(machine: Machine, listener: Listener): Set<string> {
	const scheme = listener.secure ? "https" : "http";
	const own = [...hosts(machine, listener)].map((host) => `${scheme}://${host}`);
	const deployed = app();
	return new Set(deployed ? [...own, deployed] : own);
}
