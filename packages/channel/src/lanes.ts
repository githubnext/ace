import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	configure,
	type ConversationId,
	defineDoc,
	defineExtension,
	defineTool,
	type Extension,
	LiveDoc,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

import { git, quote, run } from "./git";

/**
 * Which chat last took each lane, which only that chat may write to while it is busy, and the
 * base its Diff compares against: a full ref name, or a commit when the base named no ref.
 * Version 1 lanes have no base.
 */
export const LanesDoc = defineDoc<
	{ lanes: Record<string, { chat: ConversationId; path: string; base?: string }> }
>({
	kind: "ace.lanes",
	version: 2,
	scope: "session",
	initial: () => ({ lanes: {} }),
	migrate: (value) => ({
		lanes: value.lanes as Record<string, { chat: ConversationId; path: string }>,
	}),
});

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The initial channel name remains the lane prefix after a rename. */
export type Place = { name: string; project: string };

/** A lane's base and the commit a new worktree starts from. */
type Selection = { base: string; commit: string };

const HINT =
	'Pass base to use a local branch, tag, or commit instead, such as "HEAD" for the project\'s current commit.';

/** Fetches one remote branch to its remote-tracking ref, which then becomes the base. */
async function fetched(
	run: (args: string) => Promise<string>,
	remote: string,
	branch: string,
): Promise<Selection> {
	const base = `refs/remotes/${remote}/${branch}`;
	await run(`fetch ${quote(remote)} ${quote(`+refs/heads/${branch}:${base}`)}`).catch((error) => {
		throw new Error(`Could not fetch ${remote}/${branch}: ${error.message}\n${HINT}`);
	});
	const commit = (await run(`rev-parse --verify --end-of-options ${quote(`${base}^{commit}`)}`))
		.trim();
	return { base, commit };
}

/** A remote's HEAD names its default branch as the remote advertises it now. */
async function advertised(run: (args: string) => Promise<string>, remote: string) {
	const output = await run(`ls-remote --symref ${quote(remote)} HEAD`).catch((error) => {
		throw new Error(`Could not read ${remote}'s default branch: ${error.message}\n${HINT}`);
	});
	const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(output)?.[1];
	if (!branch) throw new Error(`${remote} advertises no default branch.\n${HINT}`);
	return fetched(run, remote, branch);
}

/**
 * Resolves a requested base in the project. Without one, a lane starts from origin's advertised
 * default branch, which a stale or missing local origin/HEAD can't be trusted to name, or from
 * the project's HEAD in a repository without origin, such as a folder Ace initialized.
 */
async function select(
	env: ExecutionEnv,
	project: string,
	requested: string | undefined,
	context: Context,
): Promise<Selection> {
	const run = (args: string) => git(env, `-C ${quote(project)} ${args}`, context);
	const remotes = (await run("remote")).split("\n");
	if (!requested && remotes.includes("origin")) return advertised(run, "origin");
	requested ||= "HEAD";
	const ref = requested.replace(/^refs\/remotes\//, "");
	const remote = remotes
		.filter((name) => name && ref.startsWith(`${name}/`))
		.sort((a, b) => b.length - a.length)[0];
	const branch = remote && ref.slice(remote.length + 1);
	if (branch === "HEAD") return advertised(run, remote!);
	// An expression such as origin/main~2 is resolved locally like any other commit.
	const isBranch = branch
		&& await run(`check-ref-format ${quote(`refs/heads/${branch}`)}`).then(() => true, () => false);
	if (isBranch) return fetched(run, remote!, branch);
	// Output is parsed, so warnings such as an ambiguous name stay out of it.
	const resolve = (option: string, revision: string) =>
		run(`rev-parse --verify ${option} --end-of-options ${quote(revision)} 2>/dev/null`).then(
			(output) => output.trim(),
			() => {
				throw new Error(`No branch, tag, or commit named ${requested}`);
			},
		);
	const full = await resolve("--symbolic-full-name", requested);
	const commit = await resolve("--quiet", `${requested}^{commit}`);
	return { base: /^refs\/(heads|tags|remotes)\//.test(full) ? full : commit, commit };
}

/** Only the chat that last took a lane may write to it while that chat is busy. */
async function guard(
	owner: ConversationId | undefined,
	chat: ConversationId,
	live: (owner: ConversationId) => Promise<{ run?: unknown } | undefined>,
	name: string,
) {
	if (!owner || owner === chat) return;
	if ((await live(owner))?.run) throw new Error(`Lane ${name} is in use by another busy chat`);
}

export function lanes(place: Place): Extension {
	return defineExtension({
		name: "ace-lanes",
		tools: [
			defineTool({
				name: "lane",
				description:
					"Start a lane (an isolated Git worktree and branch, created with the lane CLI) for a new unit of work, switch to an existing lane, or list lanes. A new lane starts from origin's default branch, fetched first, or from the project's HEAD without origin, unless base names a branch, tag, or commit; a remote branch such as origin/release is fetched first. The lane's Diff compares against that base. Passing base for an existing lane only changes what its Diff compares against; it never moves the worktree or changes the base lane push rebases onto. Starting or switching makes the lane your working directory.",
				parameters: Type.Object({
					action: Type.Union([Type.Literal("start"), Type.Literal("switch"), Type.Literal("list")]),
					name: Type.Optional(
						Type.String({
							description: "Lowercase kebab-case name for the work, such as implement-auth",
						}),
					),
					base: Type.Optional(
						Type.String({
							description:
								"Branch, tag, or commit to start from or compare against, such as HEAD, release, or origin/release",
						}),
					),
				}),
				// A rerun reuses its memoized base and finds the worktree lane created.
				replay: "safe",
				executionMode: "sequential",
				execute: async ({ action, name, base }, api, context) => {
					const env = api.env!;
					if (action === "list") {
						const state = await api.snapshot(LanesDoc, context);
						const names = Object.keys(state?.lanes || {});
						return { content: [{ type: "text", text: names.join("\n") || "No lanes yet." }] };
					}
					if (!name || !NAME.test(name)) {
						throw new Error("A lane name must be lowercase kebab-case");
					}
					const branch = `${place.name}/${name}`;
					const recorded = (await api.snapshot(LanesDoc, context))?.lanes[name];
					// `lane new` puts a lane at .lane/trees/<name>. Lanes started before Ace used it keep
					// their worktrees in the channel's directory.
					const created = `${place.project}/.lane/trees/${branch}`;
					let path = recorded?.path || created;
					const exists = await env.exists(path, context);
					if (!exists.ok) throw exists.error;
					if (action === "switch" && !exists.value) throw new Error(`No lane named ${name}`);
					await guard(
						recorded?.chat,
						api.conversationId,
						(chat) => api.snapshot(LiveDoc, chat, context),
						name,
					);
					// The selection is durable before the worktree exists, so a rerun after a crash doesn't
					// fetch again.
					let selection = await api.memo<Selection>("selection", context);
					if (!selection && (base || !exists.value)) {
						selection = await api.memo(
							"selection",
							await select(env, place.project, base, context),
							context,
						);
					}
					// lane clones ignored files such as node_modules by reference and records the base that
					// `lane push` rebases onto.
					if (!exists.value) {
						path = created;
						await run(
							env,
							`lane new ${quote(branch)} --base ${quote(selection!.base)}`,
							context,
							{ cwd: place.project },
						);
					}
					// Another chat can take the lane while this call fetches, so ownership is checked again
					// where it is claimed, and the lane keeps the base committed by then.
					const target = await api.commit(async (tx) => {
						const doc = await tx.doc(LanesDoc);
						const current = doc.lanes[name];
						await guard(current?.chat, api.conversationId, (chat) => tx.doc(LiveDoc, chat), name);
						const target = selection?.base || current?.base;
						doc.lanes[name] = {
							chat: api.conversationId,
							path,
							...(target ? { base: target } : {}),
						};
						await configure(tx, api.conversationId, { cwd: path });
						return target;
					}, context);
					const verb = exists.value ? "Switched to" : "Started";
					const from = exists.value ? "" : ` from ${selection!.commit.slice(0, 12)}`;
					const against = target ? `; its Diff compares against ${target}` : "";
					return {
						content: [{
							type: "text",
							text: `${verb} lane ${name} on branch ${branch}${from} at ${path}${against}`,
						}],
					};
				},
			}),
		],
	});
}
