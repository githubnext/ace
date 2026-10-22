/** The tailnet is the team: it says who a peer is and which machines can host channels. */
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Diagnostics } from "./protocol";

type Status = {
	BackendState: string;
	MagicDNSSuffix: string;
	Self: Node;
	Peer?: Record<string, Node>;
	User?: Record<string, { LoginName: string }>;
};
type Node = {
	HostName: string;
	DNSName: string;
	UserID: number;
	TailscaleIPs: string[];
	Online?: boolean;
	Tags?: string[];
};

/** `dns` is the full MagicDNS name, which browsers and certificates use. */
export type Machine = { name: string; login: string; address: string; dns: string };

function executable(): string | undefined {
	const path = Bun.which("tailscale", { PATH: process.env.PATH });
	if (path) return path;
	if (process.platform !== "darwin") return;
	return ["/Applications", join(homedir(), "Applications")]
		.map((dir) => join(dir, "Tailscale.app", "Contents", "MacOS", "Tailscale"))
		.find(existsSync);
}

const binary = executable();

/** Shell aliases cannot be used by a Finder-launched app or a LaunchAgent. */
function options() {
	return { env: { ...process.env, TAILSCALE_BE_CLI: "1" }, timeout: 5000 };
}

/** Who runs this host and on which tailnet, by MagicDNS suffix; nothing without Tailscale. */
export function identity(): { login?: string; tailnet?: string } {
	if (!binary) return {};
	const result = Bun.spawnSync([binary, "status", "--json"], {
		...options(),
		stderr: "ignore",
	});
	if (!result.success) return {};
	const status = JSON.parse(result.stdout.toString()) as Status;
	if (status.BackendState !== "Running") return {};
	return { login: status.User?.[status.Self.UserID]?.LoginName, tailnet: status.MagicDNSSuffix };
}

async function run(args: string[]): Promise<unknown> {
	if (!binary) throw new Error("Tailscale is not installed");
	const child = Bun.spawn([binary, ...args], { ...options(), stdout: "pipe", stderr: "pipe" });
	const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	if (code !== 0) throw new Error(`tailscale ${args[0]} failed`);
	return JSON.parse(out);
}

function machine(node: Node, status: Status): Machine {
	return {
		name: node.DNSName.split(".")[0] || node.HostName,
		dns: node.DNSName.replace(/\.$/, ""),
		login: status.User?.[node.UserID]?.LoginName ?? "",
		address: node.TailscaleIPs.find((ip) => isIP(ip) === 4) ?? node.TailscaleIPs[0]!,
	};
}

async function status(): Promise<Status | undefined> {
	try {
		const value = await run(["status", "--json"]) as Status;
		return value.BackendState === "Running" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** This machine on the tailnet, or nothing when Tailscale is not running. */
export async function self(): Promise<Machine | undefined> {
	const value = await status();
	return value && machine(value.Self, value);
}

/** This machine's tailnet, by MagicDNS suffix, or nothing when Tailscale is not running. */
export async function domain(): Promise<string | undefined> {
	return (await status())?.MagicDNSSuffix;
}

/** `started` is the tailnet the host read at startup, which its channels and listeners still use. */
export async function diagnostics(started?: string): Promise<Diagnostics["tailscale"]> {
	if (!binary) return { state: "missing" };
	try {
		const value = await run(["status", "--json"]) as Status;
		if (value.BackendState !== "Running") return { state: "offline" };
		const name = machine(value.Self, value).name;
		return value.MagicDNSSuffix === started
			? { state: "running", name }
			: { state: "running", name, restart: true };
	} catch (error) {
		return { state: "error", error: (error as Error).message };
	}
}

/**
 * Calls `moved` once Tailscale has run on a tailnet other than `started` for two checks in a row.
 * Tailscale stopping never counts: the host's channels stay on the tailnet it started on.
 */
export function watch(started: string | undefined, moved: (tailnet: string) => void): () => void {
	let seen: string | undefined;
	const timer = setInterval(async () => {
		const now = (await status())?.MagicDNSSuffix;
		if (!now || now === started) seen = undefined;
		else if (now !== seen) seen = now;
		else {
			clearInterval(timer);
			moved(now);
		}
	}, 10_000);
	return () => clearInterval(timer);
}

/** Online machines owned by people; tagged nodes are servers, not participants. */
export async function peers(): Promise<Machine[]> {
	const value = await status();
	if (!value) return [];
	return Object.values(value.Peer ?? {})
		.filter((node) => node.Online && !node.Tags?.length)
		.map((node) => machine(node, value));
}

/** Only CGNAT and ULA tailnet addresses; anything else did not arrive over Tailscale. */
export function tailnet(ip: string): string | undefined {
	const plain = ip.replace(/^::ffff:/, "");
	if (isIP(plain) === 4) {
		const [a, b] = plain.split(".").map(Number);
		return a === 100 && b! >= 64 && b! <= 127 ? plain : undefined;
	}
	return plain.toLowerCase().startsWith("fd7a:115c:a1e0:") ? plain : undefined;
}

/** A certificate for this machine's MagicDNS name, when the tailnet has HTTPS enabled. */
export async function certificate(
	dns: string,
	dir: string,
): Promise<{ cert: string; key: string }> {
	if (!binary) throw new Error("Tailscale is not installed");
	const cert = join(dir, "tailnet.crt");
	const key = join(dir, "tailnet.key");
	const child = Bun.spawn([binary, "cert", "--cert-file", cert, "--key-file", key, dns], {
		env: options().env,
		stdout: "ignore",
		stderr: "pipe",
	});
	const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error(error.trim().split("\n").at(-1) || "tailscale cert failed");
	return { cert, key };
}

/**
 * The person and machine behind an inbound TCP connection, as Tailscale verified them. Tagged
 * nodes are refused.
 */
export async function whois(ip: string, port: number): Promise<{ login: string; host: string }> {
	const address = tailnet(ip);
	if (!address) throw new Error("Not a tailnet address");
	const endpoint = isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`;
	const value = await run(["whois", "--json", "--proto=tcp", endpoint]) as {
		Node: { Name: string; Tags?: string[] };
		UserProfile: { LoginName: string };
	};
	if (value.Node.Tags?.length) throw new Error("Tagged nodes cannot participate");
	return { login: value.UserProfile.LoginName, host: value.Node.Name.split(".")[0] || address };
}
