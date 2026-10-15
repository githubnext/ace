import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { Utils } from "electrobun/bun";

import { token } from "@ace/host/auth";
import { config } from "@ace/host/config";
import { GatewayClient } from "@ace/host/gateway-client";
import { health, HostConflict } from "@ace/host/health";

import type { HelperAction, HelperState } from "./protocol";
import { service } from "./service";

async function wait(check: () => Promise<boolean>, message: string): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(100);
	}
	throw new Error(message);
}

async function exited(pid: number): Promise<void> {
	await wait(async () => {
		try {
			process.kill(pid, 0);
			return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
			throw error;
		}
	}, "Ace Helper is still shutting down. Check its log before trying again.");
}

export function helper(identifier: string, lane: boolean) {
	const agent = service(identifier);
	const receipt = join(config.home, "desktop-update.json");
	// A checkout's build uses its own source host; a registered service would outlive that code.
	const isolated =
		`This development build only uses the Ace host started by bun run dev from its checkout, on port ${config.port}.`;
	let changing = false;

	// Restarting the listener only helps when it is this app's own helper from another build.
	function advise(conflict: HostConflict): Error {
		const { listener } = conflict;
		if (lane) {
			return new Error(
				`${conflict.message} Leave it running and start this checkout with ACE_PORT set to a free port and bun desktop dev.`,
			);
		}
		if (!listener.helper) {
			return new Error(`${conflict.message} Stop that ace serve, then reopen Ace.`);
		}
		if (listener.bundle === resolve(dirname(process.execPath), "..", "..")) {
			return new Error(
				`${conflict.message} It is this app's Ace Helper from another build. Run launchctl kickstart -k gui/${
					process.getuid!()
				}/${identifier}.helper in Terminal, then reopen Ace.`,
			);
		}
		return new Error(
			`${conflict.message} Leave it running and use that app, or open it, choose Stop in its Ace Helper settings, and reopen this one.`,
		);
	}

	async function info() {
		const found = await health(config.port).catch((error) => {
			throw error instanceof HostConflict ? advise(error) : error;
		});
		if (found && found.home !== config.home) {
			throw new Error(
				`Port ${config.port} belongs to an Ace host using a different data directory`,
			);
		}
		return found;
	}

	// A health check times out while the helper is busy; only launchd knows whether it still runs.
	async function launched(): Promise<boolean> {
		const child = Bun.spawn([
			"/bin/launchctl",
			"print",
			`gui/${process.getuid!()}/${identifier}.helper`,
		], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		return /^\tpid = \d+$/m.test(out);
	}

	async function status(): Promise<HelperState> {
		const found = await info();
		const service = lane ? "unregistered" as const : agent.status();
		return {
			service,
			running: !!found,
			managed: !!found?.helper,
			unresponsive: !found && service === "enabled" && await launched(),
		};
	}

	async function start(): Promise<void> {
		if (lane) throw new Error(isolated);
		if (agent.status() === "unregistered") agent.register();
		if (agent.status() === "approval") {
			agent.settings();
			throw new Error("Allow Ace in macOS Login Items, then start Ace Helper again.");
		}
		const child = Bun.spawn([
			"/bin/launchctl",
			"kickstart",
			`gui/${process.getuid!()}/${identifier}.helper`,
		], { stdout: "ignore", stderr: "ignore" });
		if (await child.exited !== 0) {
			throw new Error("Could not start Ace Helper. Check macOS Login Items.");
		}
		await wait(async () => {
			const found = await info();
			if (found && !found.helper) throw new Error("This port is in use by a command-line host.");
			return !!found;
		}, `Ace Helper did not start. See ${join(config.home, "helper.log")}`);
	}

	async function request(op: "update-prepare" | "update-cancel") {
		const client = new GatewayClient(`ws://127.0.0.1:${config.port}/ws`, token());
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				(async () => {
					await wait(async () => client.status === "open", "Could not connect to Ace Helper");
					return client.request<{ ready: boolean } | null>({ op });
				})(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Ace Helper did not finish preparing the update")),
						30_000,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
			client.close();
		}
	}

	async function prepare(): Promise<void> {
		if (changing) throw new Error("Ace Helper is already changing state");
		changing = true;
		try {
			const found = await info();
			if (!found?.helper || agent.status() !== "enabled") {
				throw new Error(
					"Start Ace Helper before installing an update. Command-line hosts cannot be updated from the app.",
				);
			}
			// Recovery is needed even if the desktop exits between pausing and unregistering.
			writeFileSync(receipt, JSON.stringify({ helper: true }), { mode: 0o600 });
			if (!(await request("update-prepare"))?.ready) {
				throw new Error("This Ace Helper cannot prepare an update. Restart it and try again.");
			}
			agent.unregister();
			await exited(found.pid);
		} finally {
			changing = false;
		}
	}

	async function recover(): Promise<void> {
		if (!existsSync(receipt)) return;
		const found = await info();
		if (found && !found.helper) throw new Error("Stop the command-line host to resume Ace Helper");
		if (found) await request("update-cancel");
		else await start();
		rmSync(receipt);
	}

	async function act(action: HelperAction): Promise<HelperState> {
		if (action === "status") return status();
		if (action === "settings") {
			agent.settings();
			return status();
		}
		if (action === "log") {
			Utils.showItemInFolder(join(config.home, "helper.log"));
			return status();
		}
		if (lane) throw new Error(isolated);
		if (changing) throw new Error("Ace Helper is already changing state. Wait for it to finish.");
		changing = true;
		try {
			const found = await info();
			if (found && !found.helper) {
				throw new Error(
					"Ace is connected to a command-line host. Stop ace serve before managing Ace Helper.",
				);
			}
			if (action === "stop") {
				if (agent.status() !== "unregistered") agent.unregister();
				if (found) await exited(found.pid);
			} else if (action === "restart") {
				if (!found) throw new Error("Start Ace Helper before restarting it.");
				process.kill(found.pid, "SIGTERM");
				await exited(found.pid);
				await start();
			} else if (action === "start") {
				if (!found) await start();
			} else {
				throw new Error("Unknown Ace Helper action");
			}
			return await status();
		} finally {
			changing = false;
		}
	}

	return { status, act, prepare, recover, pending: () => existsSync(receipt) };
}
