import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Runs a command and returns its output, or throws that output when it exits otherwise. */
export async function run(
	env: ExecutionEnv,
	command: string,
	context: Context,
	options: { cwd?: string; ok?: number[] } = {},
): Promise<string> {
	let output = "";
	const result = await env.exec(
		command,
		{
			...(options.cwd ? { cwd: options.cwd } : {}),
			onOutput: (chunk) => (output += chunk),
		},
		context,
	);
	if (!result.ok) throw result.error;
	if (!(options.ok ?? [0]).includes(result.value.exitCode)) {
		throw new Error(output.trim() || `${command} exited ${result.value.exitCode}`);
	}
	return output;
}

/**
 * Runs git and returns stdout. Pathspecs are literal so file names can't act as globs, reads take
 * no optional locks so they never contend with the agent's own git commands, and fetches fail
 * rather than wait on a credential prompt no one can answer.
 */
export function git(
	env: ExecutionEnv,
	args: string,
	context: Context,
	options: { cwd?: string; ok?: number[] } = {},
): Promise<string> {
	return run(
		env,
		`GIT_LITERAL_PATHSPECS=1 GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 git ${args}`,
		context,
		options,
	);
}
