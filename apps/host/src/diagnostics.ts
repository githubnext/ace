import { constants } from "node:fs";
import { access } from "node:fs/promises";

import * as directory from "./directory";
import { shell as environment } from "./environment";
import { credential } from "./keys";
import type { Diagnostics } from "./protocol";
import * as tailnet from "./tailnet";

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

export async function diagnostics(): Promise<Diagnostics> {
	const [tools, tailscale, secret] = await Promise.all([
		Promise.all([git(), shell()]),
		tailnet.diagnostics(),
		credential("ACE_SECRET"),
	]);
	return {
		tools,
		tailscale,
		directory: { ...directory.status(), secret },
		shell: { ...environment },
	};
}
