import type { Diagnostics } from "./protocol";

/** A command-line host inherits its terminal's environment; only the helper loads a login shell. */
export const shell: Diagnostics["shell"] = { state: "adopted" };

const mark = "__ace_env__";
const command = () => [process.env.SHELL || "/bin/zsh", "-lc", `printf ${mark}; env -0`];
let helpers = "";

/** Returns false, recording why in `shell.error`, when the output carries no environment. */
function adopt(out: string, success: boolean, timeout: number | undefined): boolean {
	const start = out.indexOf(mark);
	if (timeout) {
		shell.error = `Your login shell took over ${timeout / 1000} seconds to start.`;
		return false;
	}
	if (!success || start < 0) {
		shell.error = "Your login shell exited with an error.";
		return false;
	}
	for (const pair of out.slice(start + mark.length).split("\0")) {
		const split = pair.indexOf("=");
		if (split < 1) continue;
		const name = pair.slice(0, split);
		// Shell profiles configure tools; the desktop and helper must agree on host settings.
		if (!name.startsWith("ACE_")) process.env[name] = pair.slice(split + 1);
	}
	// Agents and the commit hooks they run use the lane CLI this bundle ships and was built against.
	process.env.PATH = `${helpers}:${process.env.PATH}`;
	shell.state = "adopted";
	delete shell.error;
	return true;
}

/**
 * Finder and launchd do not supply the PATH used by a developer's tools.
 * Pass the adopted PATH to Bun.which; its default lookup keeps the startup PATH.
 */
export function adoptLoginShell(bin: string): void {
	helpers = bin;
	const result = Bun.spawnSync(command(), { stdin: "ignore", stderr: "ignore", timeout: 5000 });
	if (
		adopt(result.stdout.toString(), result.success, result.exitedDueToTimeout ? 5000 : undefined)
	) {
		return;
	}
	shell.state = "pending";
	process.env.PATH = `${helpers}:${process.env.PATH}`;
}

/** Seconds before each retry; a busy login can outlast the startup timeout once and then recover. */
const delays = [5, 15, 30, 60, 120, 300];

/**
 * Retries a failed startup load off the startup path, with a longer timeout. `adopted` runs in the
 * same tick as the environment change, before any new worker or tool lookup can see it.
 */
export async function retryLoginShell(adopted: () => void): Promise<void> {
	for (const delay of delays) {
		await Bun.sleep(delay * 1000);
		const child = Bun.spawn(command(), {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			timeout: 30_000,
		});
		const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		// `killed` stays true after a normal exit; the timeout is the only thing that signals it.
		if (adopt(out, code === 0, child.signalCode ? 30_000 : undefined)) return adopted();
	}
	shell.state = "failed";
}
