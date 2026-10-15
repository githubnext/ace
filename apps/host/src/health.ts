import { randomBytes, timingSafeEqual } from "node:crypto";
import { basename } from "node:path";

import { proof, token } from "./auth";
import { config } from "./config";
import { HOST_PROTOCOL, type HostInfo } from "./protocol";

/** The program behind an Ace listener, named from its PID: health is loopback-only, so it runs here. */
export type Listener = { text: string; helper: boolean; bundle?: string };

/**
 * Listeners report no path, and older ones no version, so the PID names every install. The version
 * comes from the listener: a bundle replaced under a running helper holds a newer one on disk.
 */
export function describe(info: Pick<HostInfo, "pid" | "helper" | "version">): Listener {
	const pid = String(info.pid);
	// launchd starts Ace Helper with a bundle-relative argv[0], so only its open files give the path.
	const files = Bun.spawnSync(["lsof", "-a", "-p", pid, "-d", "cwd,txt", "-Fn"], {
		stderr: "ignore",
	})
		.stdout.toString();
	const cwd = /^fcwd\nn(.+)$/m.exec(files)?.[1];
	const executable = /^ftxt\nn(.+)$/m.exec(files)?.[1];
	const bundle = /^(.+\.app)\/Contents\/MacOS\/Ace Helper$/.exec(executable || "")?.[1];
	if (bundle) {
		return {
			text: `${basename(bundle, ".app")}${
				info.version ? ` ${info.version}` : ""
			} (${bundle}, PID ${pid})`,
			helper: true,
			bundle,
		};
	}
	if (info.helper) return { text: `an Ace Helper (PID ${pid})`, helper: true };
	// A source host's command names its script relative to where it started.
	const command = Bun.spawnSync(["ps", "-o", "command=", "-p", pid], { stderr: "ignore" })
		.stdout.toString().trim();
	return {
		text: `a command-line Ace host (PID ${pid}${cwd ? ` in ${cwd}` : ""}${
			command ? `: ${command}` : ""
		})`,
		helper: false,
	};
}

/**
 * Another Ace's host answers on the port. The message only says who it is; each caller adds what
 * its user can do, since restarting a listener that belongs to another app never helps.
 */
export class HostConflict extends Error {
	constructor(
		readonly port: number,
		readonly listener: Listener,
		readonly reason: "protocol" | "owner",
		readonly home: string,
	) {
		super(
			`Port ${port} is used by ${listener.text}, ${
				reason === "protocol"
					? `which speaks a different host protocol than this Ace (${HOST_PROTOCOL})`
					: `which keeps its channels in ${home}`
			}.`,
		);
	}
}

/** A port occupied by another program must not be mistaken for Ace Helper. */
export async function health(port: number): Promise<HostInfo | undefined> {
	const url = `http://127.0.0.1:${port}/health`;
	const challenge = randomBytes(32).toString("hex");
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { "x-ace-challenge": challenge },
			signal: AbortSignal.timeout(1000),
			redirect: "error",
		});
	} catch {
		return;
	}
	const info = await response.json().catch(() => null) as Partial<HostInfo> | null;
	if (
		!response.ok || info?.app !== "ace" || typeof info.home !== "string"
		|| typeof info.pid !== "number"
	) {
		throw new Error(`Port ${port} is occupied by a service other than Ace`);
	}
	if (info.protocol !== HOST_PROTOCOL || typeof info.helper !== "boolean") {
		throw new HostConflict(
			port,
			describe({ pid: info.pid, helper: !!info.helper, version: info.version }),
			"protocol",
			info.home,
		);
	}
	const received = response.headers.get("x-ace-proof");
	if (!received || !/^[a-f0-9]{64}$/.test(received)) {
		throw new Error("Ace Helper could not authenticate itself. Restart it before opening Ace.");
	}
	const expected = proof(info as HostInfo, challenge, port, token());
	if (!timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
		if (info.home !== config.home) {
			throw new HostConflict(port, describe(info as HostInfo), "owner", info.home);
		}
		throw new Error("This listener does not belong to your Ace Helper");
	}
	return info as HostInfo;
}
