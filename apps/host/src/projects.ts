import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import * as catalog from "./catalog";
import { config } from "./config";
import { clone, remote, REMOTES, repository } from "./github";
import type { Project } from "./protocol";

/** `commit` is whether lanes can start: the folder is a Git repository with a commit. */
type Checkout = { root: string; repo?: string; commit: boolean };

/**
 * Worktrees and remotes rarely move, and listings resolve every channel's checkout. A folder without
 * a commit is checked again on each listing, so running `git init` outside Ace is noticed.
 */
const checkouts = new Map<string, Checkout>();

/**
 * A Git worktree belongs to its repository's main checkout, so lanes and other agents' worktrees
 * join that project instead of appearing as their own.
 */
export function checkout(path: string): Checkout {
	const known = checkouts.get(path);
	if (known) return known;
	const git = (args: string[]) => spawnSync("git", ["-C", path, ...args], { encoding: "utf8" });
	const worktrees = git(["worktree", "list", "--porcelain"]);
	const main = worktrees.status === 0 ? /^worktree (.+)$/m.exec(worktrees.stdout)?.[1] : undefined;
	const commit = !!main && git(["rev-parse", "--verify", "-q", "HEAD"]).status === 0;
	const value: Checkout = { root: main || path, commit };
	const remotes = git(REMOTES);
	const repo = remotes.status === 0 ? remote(remotes.stdout) : null;
	if (repo) value.repo = repo;
	if (commit) checkouts.set(path, value);
	return value;
}

function project(path: string): Project {
	const { root, repo, commit } = checkout(path);
	const value: Project = { path: root, name: repo?.split("/")[1] || basename(root) || root };
	if (repo) value.repo = repo;
	if (!commit) value.git = false;
	return value;
}

function paths(): string[] {
	try {
		const value: unknown = JSON.parse(readFileSync(join(config.home, "projects.json"), "utf8"));
		if (!Array.isArray(value) || !value.every((path) => typeof path === "string")) {
			throw new Error("Ace's project list must contain folder paths");
		}
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** Existing CLI channels remain visible without having to open their projects again. */
export function list(): Project[] {
	const values = new Map<string, Project>();
	for (const path of new Set([...paths(), ...catalog.list().map((channel) => channel.project)])) {
		const value = project(path);
		values.set(value.path, value);
	}
	return [...values.values()];
}

const expand = (value: string) =>
	value === "~" ? homedir() : value.startsWith("~/") ? homedir() + value.slice(1) : value;

/** Opening a folder must not require model credentials or create a channel. */
export function open(value: string): Project {
	let path = realpathSync(resolve(expand(value)));
	if (!statSync(path).isDirectory()) throw new Error("Choose a folder to open as a project");
	path = realpathSync(checkout(path).root);
	const opened = paths();
	if (!opened.includes(path)) {
		mkdirSync(config.home, { recursive: true, mode: 0o700 });
		const temporary = join(config.home, `.projects-${randomUUID()}.json`);
		try {
			writeFileSync(temporary, `${JSON.stringify([...opened, path], null, "\t")}\n`, {
				mode: 0o600,
			});
			renameSync(temporary, join(config.home, "projects.json"));
		} finally {
			rmSync(temporary, { force: true });
		}
	}
	return project(path);
}

/** Secrets, dependencies, and build output that a first commit of a whole folder must not take. */
const IGNORE = `# Secrets
.env
.env.*
!.env.example
!.env.sample
*.pem

# Dependencies
node_modules/
.venv/
venv/
__pycache__/
.gradle/
Pods/

# Build output and caches
target/
dist/
build/
.next/
.nuxt/
.turbo/
.cache/
coverage/
*.log

# System files
.DS_Store
Thumbs.db
`;

/**
 * Makes an opened folder a Git repository whose first commit holds its current files, since lanes
 * are worktrees of a commit and would otherwise start without them. A folder's own `.gitignore`
 * is kept as it is; one is written only where none exists.
 */
export function init(path: string): Project {
	if (!paths().includes(path)) throw new Error("Open this folder in Ace first");
	const git = (args: string[]) => {
		const result = spawnSync("git", ["-C", path, ...args], { encoding: "utf8" });
		if (result.error) throw new Error("Git is unavailable. Check This Mac in Settings.");
		if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
	};
	if (checkout(path).commit) return project(path);
	git(["init"]);
	const ignore = join(path, ".gitignore");
	if (!existsSync(ignore)) writeFileSync(ignore, IGNORE);
	git(["add", "-A"]);
	git(["commit", "--allow-empty", "-m", "Initial commit"]);
	return project(path);
}

const cloning = new Set<string>();

/**
 * Sets up a known GitHub project on this host: clones it into `value`, or opens the checkout of
 * it already there. Anything else at `value` is left untouched.
 */
export async function setup(repo: string, value: string): Promise<Project> {
	repository(repo);
	const expanded = expand(value.trim());
	if (!isAbsolute(expanded)) throw new Error("Enter a full folder path, such as ~/code/project");
	const path = resolve(expanded);
	if (cloning.has(path)) throw new Error("This folder is already being set up");
	cloning.add(path);
	try {
		if (existsSync(path)) {
			if (!statSync(path).isDirectory()) throw new Error(`${path} is a file. Choose a folder.`);
			const real = realpathSync(path);
			checkouts.delete(real);
			const found = existsSync(join(real, ".git")) ? checkout(real).repo : undefined;
			if (found?.toLowerCase() === repo.toLowerCase()) {
				// An interrupted clone already names its remote but has no commit to work from.
				const head = spawnSync("git", ["-C", real, "rev-parse", "--verify", "-q", "HEAD"]);
				if (head.status === 0) return open(real);
				throw new Error(
					`${path} has an incomplete clone of ${repo}. Remove it or choose another folder.`,
				);
			}
			if (found) throw new Error(`${path} is a checkout of ${found}. Choose another folder.`);
			if (readdirSync(real).length) {
				throw new Error(`${path} already has other files. Choose an empty or new folder.`);
			}
		}
		await clone(repo, path);
		checkouts.delete(realpathSync(path));
		return open(path);
	} finally {
		cloning.delete(path);
	}
}
