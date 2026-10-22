import { constants } from "node:fs";
import { access } from "node:fs/promises";

import { tailnet as started } from "./catalog";
import { config } from "./config";
import * as directory from "./directory";
import * as served from "./directory-server";
import { shell as environment } from "./environment";
import * as github from "./github";
import { latest } from "./keys";
import type { Diagnostics } from "./protocol";
import * as tailnet from "./tailnet";
import * as web from "./web";

async function git(): Promise<Diagnostics["tools"][number]> {
	const path = Bun.which("git", { PATH: process.env.PATH }) || undefined;
	if (!path) return { name: "Git", error: "Install Git to use project folders." };
	// Apple's git shim opens an installer; a diagnostic must only report missing tools.
	if (process.platform === "darwin" && path === "/usr/bin/git") {
		const tools = Bun.spawn(["/usr/bin/xcode-select", "--print-path"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		if (await tools.exited !== 0) {
			return { name: "Git", path, error: "Install Xcode Command Line Tools to use Git." };
		}
	}
	const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore", timeout: 3000 });
	const [version, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	return code === 0
		? { name: "Git", path, version: version.trim() }
		: { name: "Git", path, error: "Git could not start." };
}

async function shell(): Promise<Diagnostics["tools"][number]> {
	const path = process.env.SHELL || "/bin/sh";
	try {
		await access(path, constants.X_OK);
		return { name: "Shell", path };
	} catch {
		return { name: "Shell", path, error: "The login shell is not executable." };
	}
}

async function gh(): Promise<Diagnostics["tools"][number]> {
	const name = "GitHub CLI";
	const path = Bun.which("gh", { PATH: process.env.PATH }) || undefined;
	if (!path) {
		return { name, error: "Install GitHub CLI, then sign in with gh auth login, to use GitHub." };
	}
	const child = Bun.spawn([path, "auth", "status", "--hostname", "github.com", "--json", "hosts"], {
		env: github.environment(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
		timeout: 5000,
	});
	const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	if (code !== 0) return { name, path, error: "GitHub CLI could not start." };
	const { hosts } = JSON.parse(out) as {
		hosts: Record<string, { state: string; active: boolean; login: string }[]>;
	};
	const account = hosts["github.com"]?.find((account) => account.active);
	if (!account) return { name, path, error: "Sign in with gh auth login to use GitHub." };
	if (account.state !== "success" || !account.login) {
		return { name, path, error: "GitHub didn't accept this sign-in. Run gh auth login again." };
	}
	return { name, path, account: account.login };
}

export async function diagnostics(sync?: boolean): Promise<Diagnostics> {
	const secret = latest("ACE_SECRET", sync);
	if (sync) {
		const synced = directory.sync();
		// A sync that waits on a keychain prompt lands on a later poll instead of holding this answer.
		if (!(await secret).waiting) await Promise.race([synced, Bun.sleep(25_000)]);
	}
	const [tools, tailscale] = await Promise.all([
		Promise.all([git(), gh(), shell()]),
		tailnet.diagnostics(started),
	]);
	const { hosted, app, compute, hosts } = directory.read();
	return {
		tools,
		tailscale: config.loopback ? { ...tailscale, loopback: true } : tailscale,
		directory: {
			...directory.status(),
			secret: await secret,
			services: { hosted, app, compute },
			serving: served.isServing(),
			shares: served.shares(),
			hosts: hosts.map(({ address: _, ...host }) => host),
			offered: directory.offered(),
		},
		shell: { ...environment },
		web: web.address,
		http: web.plain,
	};
}
