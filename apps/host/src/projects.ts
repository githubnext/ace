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
import { clone, parse, remote, REMOTES } from "./github";
import type { Project } from "./protocol";

/** `commit` is whether lanes can start: the folder is a Git repository with a commit. */
type Checkout = { root: string; repo?: string; commit: boolean };

/** `status` is null when Git could not start. */
type Git = { status: number | null; stdout: string; stderr: string };

/** Listings probe every project; more Git processes at once only contend for the same disk. */
const LIMIT = 8;
let running = 0;
const waiting: (() => void)[] = [];

/** Git runs off the gateway's event loop, so a slow repository cannot stall every client. */
export async function git(dir: string, args: string[]): Promise<Git> {
	// A finishing call hands its slot straight to the next waiter, so the limit holds.
	if (running < LIMIT) running++;
	else await new Promise<void>((resolve) => waiting.push(resolve));
	try {
		// Without `env`, Bun resolves `git` on the startup PATH, before the login shell's is adopted.
		const child = Bun.spawn(["git", "-C", dir, ...args], {
			env: process.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, status] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { status, stdout, stderr };
	} catch {
		return { status: null, stdout: "", stderr: "" };
	} finally {
		const next = waiting.shift();
		if (next) next();
		else running--;
	}
}

/**
 * Worktrees and remotes rarely move, and listings resolve every channel's checkout. A folder without
 * a commit is checked again on each listing, so running `git init` outside Ace is noticed. Probes
 * in flight are shared, so windows connecting together do not repeat them.
 */
const checkouts = new Map<string, Promise<Checkout>>();

/**
 * A Git worktree belongs to its repository's main checkout, so lanes and other agents' worktrees
 * join that project instead of appearing as their own.
 */
export function checkout(path: string): Promise<Checkout> {
	const known = checkouts.get(path);
	if (known) return known;
	const probed = probe(path);
	checkouts.set(path, probed);
	void probed.then(({ commit }) => {
		if (!commit && checkouts.get(path) === probed) checkouts.delete(path);
	});
	return probed;
}

async function probe(path: string): Promise<Checkout> {
	const [worktrees, head, remotes] = await Promise.all([
		git(path, ["worktree", "list", "--porcelain"]),
		git(path, ["rev-parse", "--verify", "-q", "HEAD"]),
		git(path, REMOTES),
	]);
	const main = worktrees.status === 0 ? /^worktree (.+)$/m.exec(worktrees.stdout)?.[1] : undefined;
	const value: Checkout = { root: main || path, commit: !!main && head.status === 0 };
	const repo = remotes.status === 0 ? remote(remotes.stdout) : null;
	if (repo) value.repo = repo;
	return value;
}

async function project(path: string): Promise<Project> {
	const { root, repo, commit } = await checkout(path);
	const value: Project = { path: root, name: repo?.split("/")[1] || basename(root) || root };
	if (repo) value.repo = repo;
	if (!commit) {
		value.git = false;
		if (existsSync(join(root, ".gitignore"))) value.ignored = true;
	}
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
export async function list(): Promise<Project[]> {
	const found = await Promise.all(
		[...new Set([...paths(), ...catalog.list().map((channel) => channel.project)])].map(project),
	);
	return [...new Map(found.map((value) => [value.path, value])).values()];
}

const expand = (value: string) =>
	value === "~" ? homedir() : value.startsWith("~/") ? homedir() + value.slice(1) : value;

/** Opening a folder must not require model credentials or create a channel. */
export async function open(value: string): Promise<Project> {
	// A relative path would resolve against Ace Helper's working directory, which no one sees.
	const expanded = expand(value.trim());
	if (!isAbsolute(expanded)) throw new Error("Enter a full folder path, such as ~/code/project");
	if (!existsSync(expanded)) throw new Error(`There's no folder at ${expanded}. Check the path.`);
	let path = realpathSync(expanded);
	if (!statSync(path).isDirectory()) throw new Error("Choose a folder to open as a project");
	path = realpathSync((await checkout(path)).root);
	const opened = paths();
	if (!opened.includes(path)) save([...opened, path]);
	return project(path);
}

/** Removing a project forgets the folder; its files and lanes stay where they are. */
export function remove(path: string): void {
	const channels = catalog.list().filter((channel) => channel.project === path).length;
	if (channels) {
		throw new Error(
			`This project still has ${
				channels === 1 ? "a channel" : `${channels} channels`
			}, counting archived ones. Delete ${channels === 1 ? "it" : "them"} first.`,
		);
	}
	save(paths().filter((value) => value !== path));
}

function save(opened: string[]): void {
	mkdirSync(config.home, { recursive: true, mode: 0o700 });
	const temporary = join(config.home, `.projects-${randomUUID()}.json`);
	try {
		writeFileSync(temporary, `${JSON.stringify(opened, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temporary, join(config.home, "projects.json"));
	} finally {
		rmSync(temporary, { force: true });
	}
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
 * are worktrees of a commit and would otherwise start without them. Ace commits only under its
 * own `.gitignore`, so a folder that already has one is left for its owner to commit.
 */
export async function init(path: string): Promise<Project> {
	if (!paths().includes(path)) throw new Error("Open this folder in Ace first");
	const run = async (args: string[]) => {
		const result = await git(path, args);
		if (result.status === null) throw new Error("Git is unavailable. Check Settings → Ace Helper.");
		if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
	};
	if ((await checkout(path)).commit) return project(path);
	const ignore = join(path, ".gitignore");
	if (existsSync(ignore)) {
		throw new Error(
			`${path} already has a .gitignore. Initialize Git and commit its files yourself to start channels.`,
		);
	}
	await run(["init"]);
	writeFileSync(ignore, IGNORE);
	await run(["add", "-A"]);
	await run(["commit", "--allow-empty", "-m", "Initial commit"]);
	return project(path);
}

const cloning = new Set<string>();

/**
 * Sets up a GitHub repository on this host: clones it into `value`, or opens the checkout of it
 * already there, marked `found`. Anything else at `value` is left untouched.
 */
export async function setup(
	source: string,
	value: string,
): Promise<Project & { found?: true }> {
	const repo = parse(source);
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
			const found = existsSync(join(real, ".git")) ? (await checkout(real)).repo : undefined;
			if (found?.toLowerCase() === repo.toLowerCase()) {
				// An interrupted clone already names its remote but has no commit to work from.
				const head = await git(real, ["rev-parse", "--verify", "-q", "HEAD"]);
				if (head.status === 0) return { ...(await open(real)), found: true };
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
		return await open(path);
	} finally {
		cloning.delete(path);
	}
}
