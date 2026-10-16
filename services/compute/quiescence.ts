import { readdir, readFile } from "node:fs/promises";

/** Set by the controller on the commands it runs to reach the runner. */
export const CONTROL = "ACE_CONTROL=1";

let baseline: Map<number, string> | undefined;

// A dedicated container records its platform processes before accepting work. Start times
// distinguish reused PIDs; later platform processes may safely refuse a pilot checkpoint.
export async function initializeQuiescence(): Promise<void> {
	if (baseline) throw new Error("Process baseline is already initialized");
	baseline = await processes();
}

// The caller must hold the operation gate after disconnecting and draining workspace calls.
export async function assertQuiescent(): Promise<void> {
	if (!baseline) throw new Error("Process baseline is not initialized");
	const unexpected = [...await processes()]
		.filter(([pid, started]) => baseline!.get(pid) !== started)
		.map(([pid]) => pid)
		.sort((a, b) => a - b);
	if (unexpected.length) {
		throw new Error(
			`Checkpoint refused: background processes remain (PIDs ${
				unexpected.join(", ")
			}). Stop them before checkpointing`,
		);
	}
}

async function processes(): Promise<Map<number, string>> {
	const found = new Map<number, string>();
	await Promise.all(
		(await readdir("/proc")).filter((name) => /^\d+$/.test(name)).map(async (name) => {
			const pid = Number(name);
			if (pid === process.pid) return;
			let stat: string;
			try {
				stat = await readFile(`/proc/${pid}/stat`, "utf8");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ESRCH") return;
				throw error;
			}
			// comm is parenthesized and may itself contain spaces or closing parentheses.
			const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
			if (fields.length < 20 || !/^\d+$/.test(fields[19])) {
				throw new Error(`Cannot inspect process ${pid} before checkpointing`);
			}
			if (fields[0] === "Z") return;
			// The controller reaches the runner through processes it marks, which are not workspace work.
			const environ = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
			if (environ.split("\0").includes(CONTROL)) return;
			found.set(pid, fields[19]);
		}),
	);
	return found;
}
