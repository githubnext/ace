import type {
	GithubCheck,
	GithubComment,
	GithubDetail,
	GithubFile,
	GithubItem,
	GithubKind,
	GithubList,
	GithubPull,
} from "@ace/channel/protocol";

import { githubEnv } from "./keys";
import { githubRepo, type HostRequest } from "./protocol";

const REPO = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i;
const FIELDS = "number,title,url,state,author,createdAt,updatedAt,labels";

type Item = {
	number: number;
	title: string;
	url: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	isDraft?: boolean;
	author: { login: string } | null;
	createdAt: string;
	updatedAt: string;
	labels: { name: string; color: string }[];
};
type Comment = {
	id: string;
	url: string;
	author: { login: string } | null;
	body: string;
	createdAt: string;
};
type Review = Omit<Comment, "createdAt" | "url"> & {
	submittedAt: string;
	state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
};
type Detail = Item & {
	body: string;
	comments: Comment[];
	reviews?: Review[];
	baseRefName?: string;
	headRefName?: string;
	additions?: number;
	deletions?: number;
	changedFiles?: number;
	reviewDecision?: string;
};
type Check =
	| {
		__typename: "CheckRun";
		name: string;
		detailsUrl?: string;
		status: string;
		conclusion: string;
	}
	| { __typename: "StatusContext"; context: string; targetUrl?: string; state: string };
type File = {
	filename: string;
	previous_filename?: string;
	status: string;
	additions: number;
	deletions: number;
	patch?: string;
};

export function repository(value: string): string {
	if (!REPO.test(value) || [".", ".."].includes(value.split("/")[1]!)) {
		throw new Error("Choose a GitHub repository in owner/name format");
	}
	return value;
}

/** A GitHub repository URL, SSH remote, or owner/name, as a valid owner/name. */
export function parse(value: string): string {
	const repo = githubRepo(value);
	if (!repo) {
		throw new Error(
			"Ace clones GitHub repositories. Enter one such as https://github.com/owner/name or owner/name.",
		);
	}
	return repository(repo);
}

function command(kind: GithubKind): "issue" | "pr" {
	if (kind === "issues") return "issue";
	if (kind === "prs") return "pr";
	throw new Error("Choose issues or pull requests");
}

function number(value: number): string {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid GitHub item number");
	return String(value);
}

async function gh<T>(args: string[]): Promise<T> {
	const path = Bun.which("gh", { PATH: process.env.PATH });
	if (!path) throw new Error("Install GitHub CLI on this host, then sign in with gh auth login.");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...githubEnv(),
		GH_HOST: "github.com",
		GH_PROMPT_DISABLED: "1",
		GH_PAGER: "cat",
	};
	delete env.GH_REPO;
	const child = Bun.spawn([path, ...args], {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30_000,
	});
	const [out, error, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code === 4) throw new Error("Sign in to GitHub on this host with gh auth login.");
	if (code !== 0) throw new Error(error.trim() || "GitHub did not respond. Try again.");
	return JSON.parse(out) as T;
}

/**
 * A plain Git clone, so public repositories need no GitHub account and organization SSO cannot
 * block them. Private ones use this host's existing Git credential helpers, with the token gh
 * would see. Git never prompts, since the helper has no terminal. Ace never removes anything at
 * `path`; only Git cleans up what its own failed clone created.
 */
export async function clone(repo: string, path: string): Promise<void> {
	const child = Bun.spawn([
		"git",
		"clone",
		"--",
		`https://github.com/${repository(repo)}.git`,
		path,
	], {
		env: { ...process.env, ...githubEnv(), GIT_TERMINAL_PROMPT: "0" },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
		timeout: 30 * 60_000,
	});
	const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	if (code === 0) return;
	if (child.signalCode) throw new Error("Cloning took too long and was stopped. Try again.");
	const detail = error.trim().split("\n").filter((line) => !line.startsWith("Cloning into"))
		.slice(-4).join("\n");
	if (/\bSAML\b|\bSSO\b|single sign-on/i.test(error)) {
		throw new Error(
			`${
				repo.split("/")[0]
			} requires single sign-on for this repository. Authorize this host's Git credentials for the organization on GitHub, then try again.\n${detail}`,
		);
	}
	if (/terminal prompts disabled|could not read Username|Authentication failed/i.test(error)) {
		throw new Error(
			`GitHub needs credentials to clone ${repo}. Set up Git credentials on this host, for example with gh auth setup-git, then try again.`,
		);
	}
	// GitHub answers "not found" for private repositories the credentials can't read.
	if (/Repository not found/i.test(error)) {
		throw new Error(
			`GitHub didn't find ${repo} for this host's Git credentials. Check the name, and that the signed-in account has access; a pending invitation must be accepted first.\n${detail}`,
		);
	}
	throw new Error(detail || `Could not clone ${repo}.`);
}

let owner: string | undefined;
let checked = 0;

/**
 * The owner's GitHub login from gh, for avatars. Unknown until resolved; a missing or signed-out
 * gh is checked again at most every five minutes, so signing in later takes effect.
 */
export function login(changed: () => void): string | undefined {
	if (!owner && Date.now() - checked > 300_000) {
		checked = Date.now();
		gh<{ login: string }>(["api", "user"]).then((user) => {
			owner = user.login;
			changed();
		}, () => {});
	}
	return owner;
}

export const REMOTES = ["config", "--local", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"];

/** The GitHub repository in `git config` output for REMOTES, preferring gh's chosen base. */
export function remote(config: string): string | null {
	const remotes = new Map<string, string>();
	let preferred: string | undefined;
	for (const line of config.trim().split("\n")) {
		const match = /^remote\.(.+)\.(url|gh-resolved)\s+(.+)$/.exec(line);
		if (!match) continue;
		const name = match[1]!;
		const field = match[2]!;
		const value = match[3]!;
		if (field === "gh-resolved" && value === "base") preferred = name;
		if (field === "url") remotes.set(name, value);
	}
	for (const name of [preferred, "origin", "upstream", ...remotes.keys()]) {
		const url = name ? remotes.get(name) : undefined;
		if (!url) continue;
		const match =
			/^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::443)?\/)([^/]+\/[^/]+?)\/?$/i
				.exec(url);
		if (!match) continue;
		const repo = match[1]!.replace(/\.git$/i, "");
		if (REPO.test(repo)) return repository(repo);
	}
	return null;
}

/** Reading a remote needs no GitHub credentials, including on a teammate's host. */
export async function project(path: string): Promise<string | null> {
	const child = Bun.spawn(["git", "-C", path, ...REMOTES], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
		timeout: 5000,
	});
	const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	return code === 0 ? remote(out) : null;
}

function item(value: Item, kind: GithubKind): GithubItem {
	return {
		kind,
		number: value.number,
		title: value.title,
		url: value.url,
		state: value.state === "MERGED"
			? "merged"
			: value.state === "CLOSED"
			? "closed"
			: value.isDraft
			? "draft"
			: "open",
		author: value.author?.login || "ghost",
		created: value.createdAt,
		updated: value.updatedAt,
		labels: value.labels.map(({ name, color }) => ({ name, color })),
	};
}

export async function list(
	request: Extract<HostRequest, { op: "github-list" }>,
): Promise<GithubList> {
	const { repo, kind, state, search, limit } = request;
	if (!["open", "closed", "all"].includes(state)) throw new Error("Invalid GitHub state filter");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
		throw new Error("Load between 1 and 1000 GitHub items");
	}
	const values = await gh<Item[]>([
		command(kind),
		"list",
		"--repo",
		repository(repo),
		"--state",
		state,
		"--limit",
		String(limit + 1),
		"--search",
		`${search} sort:updated-desc`.trim(),
		"--json",
		FIELDS + (kind === "prs" ? ",isDraft" : ""),
	]);
	return {
		items: values.slice(0, limit).map((value) => item(value, kind)),
		more: values.length > limit,
	};
}

export async function detail(
	request: Extract<HostRequest, { op: "github-detail" }>,
): Promise<GithubDetail> {
	const { repo, kind } = request;
	const value = await gh<Detail>([
		command(kind),
		"view",
		number(request.number),
		"--repo",
		repository(repo),
		"--json",
		FIELDS + ",body,comments" + (kind === "prs"
			? ",isDraft,reviews,baseRefName,headRefName,additions,deletions,changedFiles,reviewDecision"
			: ""),
	]);
	const comments: GithubComment[] = value.comments.map((comment) => ({
		id: comment.id,
		url: comment.url,
		author: comment.author?.login || "ghost",
		body: comment.body,
		created: comment.createdAt,
	}));
	for (const review of value.reviews || []) {
		if (review.state === "PENDING") continue;
		comments.push({
			id: review.id,
			url: value.url,
			author: review.author?.login || "ghost",
			body: review.body,
			created: review.submittedAt,
			review: review.state.toLowerCase() as GithubComment["review"],
		});
	}
	comments.sort((a, b) => a.created.localeCompare(b.created));
	return {
		...item(value, kind),
		body: value.body,
		comments,
		...(kind === "prs"
			? {
				pull: {
					base: value.baseRefName!,
					head: value.headRefName!,
					adds: value.additions!,
					dels: value.deletions!,
					files: value.changedFiles!,
					review: value.reviewDecision!,
				},
			}
			: {}),
	};
}

function check(value: Check): GithubCheck {
	if (value.__typename === "StatusContext") {
		const state = value.state === "SUCCESS"
			? "passed"
			: ["FAILURE", "ERROR"].includes(value.state)
			? "failed"
			: "pending";
		return { name: value.context, ...(value.targetUrl ? { url: value.targetUrl } : {}), state };
	}
	const state = value.status !== "COMPLETED"
		? "pending"
		: value.conclusion === "SUCCESS"
		? "passed"
		: ["NEUTRAL", "SKIPPED", "STALE"].includes(value.conclusion)
		? "skipped"
		: "failed";
	return { name: value.name, ...(value.detailsUrl ? { url: value.detailsUrl } : {}), state };
}

/** The newest pull request whose head is `branch`, or null when there is none. */
export async function pull(repo: string, branch: string): Promise<GithubPull | null> {
	if (!branch || branch.startsWith("-")) throw new Error("Invalid branch name");
	const [value] = await gh<(Item & { isDraft: boolean; statusCheckRollup: Check[] })[]>([
		"pr",
		"list",
		"--repo",
		repository(repo),
		`--head=${branch}`,
		"--state",
		"all",
		"--limit",
		"1",
		"--json",
		`${FIELDS},isDraft,statusCheckRollup`,
	]);
	if (!value) return null;
	return { ...item(value, "prs"), checks: value.statusCheckRollup.map(check) };
}

export async function files(repo: string, id: number): Promise<GithubFile[]> {
	const pages = await gh<File[][]>([
		"api",
		`repos/${repository(repo)}/pulls/${number(id)}/files?per_page=100`,
		"--paginate",
		"--slurp",
	]);
	return pages.flat().map((file) => {
		const from = file.previous_filename || file.filename;
		const old = file.status === "added" ? "/dev/null" : `a/${from}`;
		const next = file.status === "removed" ? "/dev/null" : `b/${file.filename}`;
		let patch = `diff --git ${JSON.stringify(`a/${from}`)} ${
			JSON.stringify(`b/${file.filename}`)
		}\n`;
		if (file.status === "renamed") {
			patch += `rename from ${JSON.stringify(from)}\nrename to ${JSON.stringify(file.filename)}\n`;
		}
		patch += `--- ${JSON.stringify(old)}\n+++ ${JSON.stringify(next)}\n${file.patch || ""}\n`;
		const hasPatch = file.patch !== undefined
			|| (file.status === "renamed" && !file.additions && !file.deletions);
		return {
			file: file.filename,
			from: file.previous_filename,
			adds: file.additions,
			dels: file.deletions,
			signature: new Bun.CryptoHasher("sha256").update(patch).digest("hex"),
			patch: hasPatch ? patch : undefined,
			error: hasPatch ? undefined : "GitHub did not include a text diff for this file.",
		};
	});
}
