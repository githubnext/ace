import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const WORKSPACE_ROOT = "/workspace";
export const PROJECT_ROOT = `${WORKSPACE_ROOT}/project`;
export const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;

// Callers must disconnect and drain the workspace before either operation. Git worktree
// metadata contains absolute paths, so a checkpoint must return to the same workspace path.
// Credentials belong outside this directory. Excluding dependencies is not secret scanning:
// arbitrary tracked, untracked, and ignored repository files remain in the archive.
export async function checkpoint(): Promise<Uint8Array> {
	await requireProject(WORKSPACE_ROOT);
	const child = Bun.spawn([
		"tar",
		"-czf",
		"-",
		"--exclude=node_modules",
		"-C",
		WORKSPACE_ROOT,
		".",
	], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const error = new Response(child.stderr).text();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for await (const chunk of child.stdout) {
			size += chunk.byteLength;
			if (size > MAX_CHECKPOINT_BYTES) {
				throw new Error("Checkpoint exceeds the 16 MiB pilot limit; no files were saved");
			}
			chunks.push(chunk);
		}
		const code = await child.exited;
		if (code !== 0) throw new Error(`Checkpoint failed: ${(await error).trim()}`);
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	} finally {
		if (child.exitCode === null) child.kill();
		await Promise.all([child.exited, error]);
	}
}

export async function restore(bytes: Uint8Array): Promise<void> {
	if (!bytes.byteLength) throw new Error("Checkpoint is empty");
	if (bytes.byteLength > MAX_CHECKPOINT_BYTES) {
		throw new Error("Checkpoint exceeds the 16 MiB pilot limit");
	}
	await mkdir(WORKSPACE_ROOT, { recursive: true });
	if ((await readdir(WORKSPACE_ROOT)).length) {
		throw new Error("Restore requires an empty /workspace; existing project files were preserved");
	}
	const stage = await mkdtemp(join(WORKSPACE_ROOT, ".restore-"));
	try {
		const child = Bun.spawn(["tar", "-xzf", "-", "--no-same-owner", "-C", stage], {
			stdin: bytes,
			stdout: "ignore",
			stderr: "pipe",
		});
		const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		if (code !== 0) throw new Error(`Restore failed: ${error.trim()}`);
		await requireProject(stage);
		for (const entry of await readdir(stage)) {
			await rename(join(stage, entry), join(WORKSPACE_ROOT, entry));
		}
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

async function requireProject(root: string): Promise<void> {
	const project = join(root, "project");
	if (
		!(await lstat(project)).isDirectory() || !(await lstat(join(project, ".git"))).isDirectory()
	) {
		throw new Error("Checkpoint requires a complete Git repository at /workspace/project");
	}
}
