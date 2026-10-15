/** Why the login shell's environment wasn't adopted, for diagnostics; tools then resolve from launchd's PATH. */
export let shellError: string | undefined;

/**
 * Finder and launchd do not supply the PATH used by a developer's tools.
 * Pass the adopted PATH to Bun.which; its default lookup keeps the startup PATH.
 */
export function adoptLoginShell(): void {
	const shell = process.env.SHELL || "/bin/zsh";
	const mark = "__ace_env__";
	const result = Bun.spawnSync([shell, "-lc", `printf ${mark}; env -0`], {
		stdin: "ignore",
		stderr: "ignore",
		timeout: 5000,
	});
	const out = result.stdout.toString();
	const start = out.indexOf(mark);
	if (result.exitedDueToTimeout) {
		shellError =
			"Your login shell took over 5 seconds to start, so Ace is using a minimal PATH. Restart Ace Helper to try again.";
		return;
	}
	if (!result.success || start < 0) {
		shellError =
			"Your login shell failed to start, so Ace is using a minimal PATH and may not find your tools.";
		return;
	}
	for (const pair of out.slice(start + mark.length).split("\0")) {
		const split = pair.indexOf("=");
		if (split < 1) continue;
		const name = pair.slice(0, split);
		// Shell profiles configure tools; the desktop and helper must agree on host settings.
		if (!name.startsWith("ACE_")) process.env[name] = pair.slice(split + 1);
	}
}
