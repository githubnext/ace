import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Subprocess } from "bun";

import { config, desktop } from "@ace/host/config";
import { describe, health, HostConflict } from "@ace/host/health";

import { devIdentity } from "./sign";
import { run } from "./downloads";

export const root = fileURLToPath(new URL("..", import.meta.url));

export async function build(channel: string): Promise<void> {
	if (process.platform !== "darwin" || process.arch !== "arm64") {
		throw new Error("Ace desktop currently builds on Apple silicon Macs");
	}
	if (!["dev", "stable", "canary"].includes(channel)) {
		throw new Error("Choose dev, stable, or canary");
	}
	if (channel === "dev") devIdentity();
	process.env.ACE_BUILD_CHANNEL = channel;
	const sdk = join(root, "node_modules", "electrobun");
	const cli = join(sdk, "bin", "electrobun");
	if (!existsSync(cli)) {
		const version = (await Bun.file(join(sdk, "package.json")).json()).version;
		if (version !== "1.18.1") {
			throw new Error("Update the pinned Electrobun CLI checksum with its version");
		}
		const response = await fetch(
			`https://github.com/blackboardsh/electrobun/releases/download/v${version}/electrobun-cli-darwin-arm64.tar.gz`,
		);
		if (!response.ok) throw new Error(`Electrobun CLI download failed: ${response.status}`);
		const archive = Buffer.from(await response.arrayBuffer());
		if (
			createHash("sha256").update(archive).digest("hex")
				!== "1ef4a4b42a957d3349f491f7fbe53153d1d5f427bacbda340c8d7fadce6b58d9"
		) {
			throw new Error("Electrobun CLI checksum does not match the pinned release");
		}
		const cache = join(root, ".tmp");
		mkdirSync(cache, { recursive: true });
		const path = join(cache, "electrobun-cli.tar.gz");
		writeFileSync(path, archive);
		run(["/usr/bin/tar", "-xzf", path, "-C", join(sdk, "bin")]);
		rmSync(path);
	}
	// The compiled CLI's appended Bun program invalidates its upstream ad-hoc signature.
	run(["/usr/bin/codesign", "--force", "--sign", "-", cli]);
	run([process.execPath, "scripts/stage.ts"], { cwd: root });
	run([cli, "build", `--env=${channel}`], { cwd: root });
}

/** Runs this checkout's development app with its own source host and isolated profile. */
async function dev(): Promise<void> {
	let host: Subprocess | undefined;
	let app: Subprocess | undefined;
	let stopped = false;
	// The native launcher retains and terminates only the app instance opened by this run.
	const stop = () => {
		stopped = true;
		if (app) return app.kill();
		host?.kill("SIGTERM");
	};
	// Signals during the synchronous build are handled after it, before anything is launched.
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
	await build("dev");
	if (stopped) return;
	const bin = join(root, "dist", "dev-macos-arm64", "Ace-dev.app", "Contents", "MacOS");
	const { identifier } = await Bun.file(join(bin, "..", "Resources", "version.json")).json() as {
		identifier: string;
	};
	const { profile } = await Bun.file(join(bin, "..", "Resources", "profile.json")).json() as {
		profile?: string;
	};
	if (!desktop(identifier, profile)) {
		throw new Error(`${identifier} is not a checkout development build`);
	}
	if (config.port >= 4140 && config.port <= 4142) {
		throw new Error(`Port ${config.port} belongs to an installed Ace. Choose another ACE_PORT.`);
	}
	// Attaching to an existing listener would serve another run's or checkout's code.
	const running = await health(config.port).catch((error) => {
		throw new Error(
			`${
				error instanceof HostConflict
					? error.message
					: `Port ${config.port} is used by another program.`
			} Leave it running and set ACE_PORT to run this checkout on another port.`,
		);
	});
	if (running) {
		throw new Error(
			`Port ${config.port} already has this checkout's Ace host: ${
				describe(running).text
			}. Stop it, or set ACE_PORT.`,
		);
	}
	// Other Ace settings in the environment belong to other hosts, such as directory publishing.
	const env: Record<string, string | undefined> = Object.fromEntries(
		Object.entries(process.env).filter(([name]) =>
			!name.startsWith("ACE_") || /^ACE_\w+_API_KEY$/.test(name)
		),
	);
	Object.assign(env, {
		ACE_HOME: config.home,
		ACE_CONFIG_HOME: config.settings,
		ACE_KEYCHAIN_SERVICE: config.keychain,
		ACE_PORT: String(config.port),
		// The same lane CLI Ace Helper puts on its agents' PATH.
		PATH: `${join(bin, "..", "Helpers")}:${process.env.PATH}`,
	});
	host = Bun.spawn([
		process.execPath,
		"--no-env-file",
		join(root, "..", "host", "src", "cli.ts"),
		"serve",
		// Its port is this checkout's, so teammates couldn't reach it, and a directory entry under
		// this machine's name would replace the installed Ace's.
		"--loopback",
	], { env, stdio: ["ignore", "inherit", "inherit"] });
	try {
		const deadline = Date.now() + 30_000;
		while (!(await health(config.port))) {
			if (stopped) return;
			if (host.exitCode !== null || Date.now() > deadline) {
				throw new Error(`This checkout's Ace host did not start on port ${config.port}`);
			}
			await Bun.sleep(100);
		}
		console.log(`Ace-dev ${identifier} (${profile}): ${config.home}, port ${config.port}`);
		if (stopped) return;
		app = Bun.spawn([join(bin, "ace-dev-launcher"), join(bin, "..", "..")], {
			cwd: bin,
			env,
			stdio: ["ignore", "inherit", "inherit"],
		});
		void host.exited.then(stop);
		await app.exited;
	} finally {
		host.kill("SIGTERM");
		await host.exited;
	}
}

if (import.meta.main) {
	if (process.argv.includes("--run")) await dev();
	else await build(process.argv[2] || "dev");
}
