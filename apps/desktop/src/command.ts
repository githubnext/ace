import { lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { CommandAction, CommandState } from "./protocol";

/**
 * Links `name` in `dir` to this app's Ace Helper, which runs the CLI when started under another
 * name. The link follows the bundle, so app updates keep the command current.
 */
export function command(name: string, target: string, dir: string) {
	const path = join(dir, name);

	function link(): CommandState["link"] {
		let stat;
		try {
			stat = lstatSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
			throw error;
		}
		if (!stat.isSymbolicLink()) return "other";
		const current = readlinkSync(path);
		if (current === target) return "installed";
		return /\.app\/Contents\/MacOS\/Ace Helper$/.test(current) ? "stale" : "other";
	}

	/** Shells set PATH in either profile, so ask an interactive login shell, as Terminal starts. */
	async function resolve(): Promise<string | undefined> {
		const child = Bun.spawn(
			[process.env.SHELL || "/bin/zsh", "-ilc", `command -v ${name}`],
			{ stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 },
		);
		const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		return out.trim().split("\n").findLast((line) => line.startsWith("/"));
	}

	async function status(): Promise<CommandState> {
		return { name, path, link: link(), shell: await resolve() };
	}

	async function act(action: CommandAction): Promise<CommandState> {
		const current = link();
		if (action === "install" && current !== "installed") {
			if (current === "other") {
				throw new Error(`${path} already exists and isn't Ace's. Remove it, then try again.`);
			}
			// A translocated app runs from a temporary copy that disappears when it quits.
			if (target.includes("/AppTranslocation/")) {
				throw new Error("Move Ace to your Applications folder, open it from there, and try again.");
			}
			mkdirSync(dir, { recursive: true });
			const temporary = `${path}.${process.pid}`;
			symlinkSync(target, temporary);
			renameSync(temporary, path);
		}
		if (action === "remove" && (current === "installed" || current === "stale")) unlinkSync(path);
		return status();
	}

	return { status, act };
}
