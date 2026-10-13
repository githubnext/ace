import type { Event, REPO } from "../types";

import { normalizeGithubComment } from "./github-comment";
import {
	captionTools,
	createsFile,
	editsFile,
	summarizeTools,
	summarizeWorkingTools,
	type ToolGroup,
	type ToolNode,
	toToolNode,
} from "./tool-summary";

/** Individual image data for grids. */
type ImageNode = {
	src: string;
	width: number;
	height: number;
	alt?: string;
};

/** An edited file with line diff stats. */
type EditedFile = {
	path: string;
	name: string;
	adds?: number;
	dels?: number;
};

type Artifact = {
	kind: "document" | "issue" | "pull-request" | "comment" | "label";
	title: string;
	meta: string;
	url?: string;
	path?: string;
	number?: number;
};

/** Discriminated union of structured content chunks. */
type Chunk =
	| { kind: "text"; raw: string }
	| { kind: "code"; source: string; language?: string }
	| { kind: "diff"; patch: string }
	| { kind: "image"; src: string; width: number; height: number; alt?: string }
	| { kind: "image-grid"; images: ImageNode[] }
	| { kind: "file"; name: string; url: string }
	| { kind: "tool-group"; tools: ToolNode[] }
	| { kind: "commit"; sha: string; message: string; authors: string[]; url?: string }
	| { kind: "pr"; pr: string; url: string; title: string; draft: boolean }
	| { kind: "pr-update"; pr: string; url?: string; value?: string; title?: string; body?: string }
	| { kind: "pr-comment"; pr: string; author: string; url?: string }
	| {
		kind: "pr-review";
		pr: string;
		action: "approved" | "commented" | "changes_requested" | "dismissed";
		reviewer: string;
		url?: string;
		/** Whether a markdown body follows (renders as a bubble). */
		bubble: boolean;
	}
	| {
		kind: "pr-review-comment";
		pr: string;
		author: string;
		path: string;
		line?: number;
		url?: string;
		/** Whether a markdown body follows (renders as a bubble). */
		bubble: boolean;
	}
	| { kind: "issue"; issue: string; author: string; url?: string }
	| { kind: "issue-comment"; issue: string; author: string; url?: string }
	| { kind: "issue-update"; issue: string; url?: string; value: "open" | "closed" }
	| {
		kind: "exec";
		id: string;
		input: string;
		cwd?: string;
		pid?: number;
		stdout?: string;
		stderr?: string;
		exitCode?: number | string;
		ms?: number | string;
		aborted?: boolean;
		target?: { uid: string; input: string };
	}
	| { kind: "presence"; action: "join" | "leave"; sender: string }
	| { kind: "call"; action: "start" | "end"; sender: string };

/**
 * Whether a chunk is a GitHub comment-style header (PR conversation comment,
 * review summary, or inline review comment) — these render their markdown body
 * in a bubble below a compact byline.
 */
export function isCommentChunk(kind: Chunk["kind"] | undefined): boolean {
	return kind === "pr-comment" || kind === "pr-review" || kind === "pr-review-comment"
		|| kind === "issue" || kind === "issue-comment";
}

/** A visual row in the scroll view. */
type Row = {
	uid: string;
	ts: number;
	role: "user" | "assistant" | "system";
	sender?: Event.Sender["value"];
	display?: Event.Sender["display"];
	run?: string;
	/** Agent selection used for this user message. */
	agent?: Event.Message.User["agent"];
	/** Unix seconds when the underlying event was edited. */
	edited?: number;
	/** Client-only top-level assistant draft that should render as final text. */
	streaming?: boolean;
	/** True when this row is visually grouped with the previous (hide avatar/byline). */
	grouped: boolean;
	chunks: Chunk[];
	/** Reactions on the underlying message event, if any. */
	reactions?: Event.Message.Reaction[];
};

/**
 * A group of consecutive same-sender messages within a time window.
 * Single avatar + byline for the whole group.
 */
type Group = {
	id: string;
	role: "user" | "assistant";
	sender?: Event.Sender["value"];
	display?: Event.Sender["display"];
	run?: string;
	rows: Row[];
	/** Unix seconds of the last row in the group — used for the byline. */
	ts: number;
};

/** Legacy sessions use a boolean; native runs identify the exact active author and turn. */
type TimelineWorking = boolean | { run: string; sender: Event.Sender.Agent };

/**
 * Working items within an agent turn — intermediate text and tool calls
 * shown in a collapsible section under the intent header.
 */
type WorkingItem =
	| {
		type: "text";
		id: string;
		uid: string;
		chunks: Chunk[];
		reactions?: Event.Message.Reaction[];
	}
	| {
		type: "tools";
	}
		& ToolGroup;

/**
 * Structured agent turn with intent-based grouping.
 * Separates working items (tools, intermediate text) from the final response.
 */
type AgentTurn = {
	/** Collapsed label for the working context once a final answer exists. */
	summary: string;
	/** Intermediate items: tool calls and text produced while working. */
	working: WorkingItem[];
	/** The final text-only response, shown outside the collapsible section. */
	final?: Row;
	/** Files edited during this turn, with +/- line counts. */
	files: EditedFile[];
	/** Documents, issues, and other generated outputs produced during this turn. */
	artifacts: Artifact[];
};

/**
 * A timeline entry — either a message group or a standalone system event.
 * System events break message groups and are never grouped with anything.
 */
type TimelineItem =
	| { kind: "group"; group: Group; turn?: AgentTurn }
	| { kind: "event"; row: Row }
	| { kind: "day"; ts: number };

// -- Constants --

/** Messages within 5 minutes of each other from the same sender are grouped. */
const GROUP_WINDOW = 5 * 60;
const VM_PROJECT_PREFIX = "/workspace/project/";

// -- Helpers --

/** Resolve image src from Content.Image's union field. */
function src(image: string | { url: string }): string {
	return typeof image === "string" ? image : image.url;
}

/** Extract the basename from a file path. */
function basename(path: string): string {
	let slash = path.replaceAll("\\", "/");
	return slash.slice(slash.lastIndexOf("/") + 1);
}

function extension(path: string): string {
	let name = basename(path);
	let dot = name.lastIndexOf(".");
	return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : "FILE";
}

/** Unix seconds of the local-time start of the day containing `ts`. */
function dayStart(ts: number): number {
	let d = new Date(ts * 1000);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
}

/** Check if a path is the root plan file (excluded from file pills). */
function isPlan(path: string): boolean {
	let p = repoPath(path) ?? path.replaceAll("\\", "/");
	return p === "plan.md";
}

function isDocument(path: string): boolean {
	let ext = extension(path).toLowerCase();
	return ["md", "mdx", "txt", "rst", "pdf", "doc", "docx"].includes(ext);
}

function repoPath(path: string): string | undefined {
	let p = path.replaceAll("\\", "/");
	if (p.startsWith(VM_PROJECT_PREFIX)) p = p.slice(VM_PROJECT_PREFIX.length);
	else if (p.startsWith("/")) return;
	if (p.startsWith("./")) p = p.slice(2);
	if (
		!p || p === "." || p === ".." || p.startsWith("../") || p.includes("/../") || p.endsWith("/..")
	) return;
	return p;
}

function commitUrl(project: REPO | undefined, sha: string): string | undefined {
	return project ? `https://github.com/${project}/commit/${sha}` : undefined;
}

function prUrl(project: REPO | undefined, pr: string): string | undefined {
	return project ? `https://github.com/${project}/pull/${pr.replace(/^#/, "")}` : undefined;
}

function issueUrl(project: REPO | undefined, issue: string): string | undefined {
	return project ? `https://github.com/${project}/issues/${issue.replace(/^#/, "")}` : undefined;
}

// -- Content → Chunk[] --

/** Structure a single message's content array into chunks. */
function structure(
	content: Array<Event.Message.Content | Event.Message.Content.Tool>,
): Chunk[] {
	let chunks: Chunk[] = [];

	for (let c of content) {
		switch (c.type) {
			case "text":
				chunks.push({ kind: "text", raw: c.text });
				break;
			case "image":
				chunks.push({ kind: "image", src: src(c.image), width: 0, height: 0 });
				break;
			case "file":
				chunks.push({
					kind: "file",
					name: c.name,
					url: typeof c.file === "string" ? c.file : c.file.url,
				});
				break;
			case "tool":
				chunks.push({ kind: "tool-group", tools: [toToolNode(c)] });
				break;
		}
	}

	return merge(chunks);
}

/** Merge adjacent chunks of the same kind. */
function merge(chunks: Chunk[]): Chunk[] {
	let out: Chunk[] = [];

	for (let chunk of chunks) {
		let prev = out[out.length - 1];

		// Adjacent text chunks join into one paragraph.
		if (prev && prev.kind === "text" && chunk.kind === "text") {
			prev.raw += "\n\n" + chunk.raw;
		} // Adjacent tool chunks merge into one group.
		else if (prev && prev.kind === "tool-group" && chunk.kind === "tool-group") {
			prev.tools.push(...chunk.tools);
		} // Two adjacent images start a grid.
		else if (prev && prev.kind === "image" && chunk.kind === "image") {
			out[out.length - 1] = {
				kind: "image-grid",
				images: [
					{ src: prev.src, width: prev.width, height: prev.height, alt: prev.alt },
					{ src: chunk.src, width: chunk.width, height: chunk.height, alt: chunk.alt },
				],
			};
		} // Additional images append to existing grid.
		else if (prev && prev.kind === "image-grid" && chunk.kind === "image") {
			prev.images.push({
				src: chunk.src,
				width: chunk.width,
				height: chunk.height,
				alt: chunk.alt,
			});
		} else {
			out.push(chunk);
		}
	}

	return out;
}

// -- Event → Row --

/** Convert a single event into a Row, or null if unhandled. */
function eventToRow(event: Event, project?: REPO, aborted = false): Row | null {
	let base = { uid: event.uid, ts: event.created_at, edited: event.last_updated, grouped: false };

	switch (event.type) {
		// Chat messages from users or agents.
		case "message": {
			let role = event.sender.kind === "user" ? "user" as const : "assistant" as const;
			let agent = event.sender.kind === "user"
				? (event as Event.Message & Event.Message.User).agent
				: undefined;
			let streaming = role === "assistant" && (event as { streaming?: boolean }).streaming === true;
			let chunks = structure(event.content);
			return {
				...base,
				role,
				sender: event.sender.value,
				display: event.sender.display,
				...(agent ? { agent } : undefined),
				streaming,
				run: "run" in event ? event.run : undefined,
				chunks,
				reactions: event.reactions,
			};
		}

		// Git: new commit with sha, message, and co-authors.
		case "git:commit":
			return {
				...base,
				role: "system",
				chunks: [{
					kind: "commit",
					sha: event.sha,
					message: event.message,
					authors: event.authors,
					url: commitUrl(project, event.sha),
				}],
			};

		// Git: new pull request opened.
		case "git:pr:new":
			return {
				...base,
				role: "system",
				chunks: [{
					kind: "pr",
					pr: event.pr,
					url: event.url,
					title: event.title,
					draft: event.draft,
				}],
			};

		// Git: pull request state changed (merged, closed, draft, ready).
		case "git:pr:state":
			return {
				...base,
				role: "system",
				chunks: [{
					kind: "pr-update",
					pr: event.pr,
					url: prUrl(project, event.pr),
					value: event.value,
				}],
			};

		// Git: pull request title or body edited.
		case "git:pr:edit":
			return {
				...base,
				role: "system",
				chunks: [{
					kind: "pr-update",
					pr: event.pr,
					url: prUrl(project, event.pr),
					title: event.title,
					body: event.body,
				}],
			};

		// Shell command executed by a user.
		case "exec":
			return {
				...base,
				role: "system",
				sender: event.sender.value,
				chunks: [{
					kind: "exec",
					id: event.uid,
					input: event.input,
					cwd: event.cwd,
					pid: event.pid,
					stdout: event.stdout,
					stderr: event.stderr,
					exitCode: event.exitCode,
					ms: event.executionTimeMs,
					aborted,
				}],
			};

		// Shell command aborted by a user.
		case "exec:abort":
			return {
				...base,
				role: "system",
				sender: event.sender.value,
				chunks: [{
					kind: "exec",
					id: event.uid,
					input: event.target.input,
					aborted: true,
					target: event.target,
				}],
			};

		case "git:pr:comment": {
			let comment = normalizeGithubComment(event.body);
			return {
				...base,
				role: "system",
				chunks: [
					{ kind: "pr-comment", pr: event.pr, author: event.author, url: event.url },
					...(comment.body ? [{ kind: "text" as const, raw: comment.body }] : []),
				],
			};
		}

		// Git: pull request review summary (approved / changes requested / etc).
		case "git:pr:review": {
			let comment = normalizeGithubComment(event.body ?? "");
			let bubble = !!comment.body;
			return {
				...base,
				role: "system",
				chunks: [
					{
						kind: "pr-review",
						pr: event.pr,
						action: event.action,
						reviewer: event.reviewer,
						url: prUrl(project, event.pr),
						bubble,
					},
					...(bubble ? [{ kind: "text" as const, raw: comment.body }] : []),
				],
			};
		}

		// Git: inline (code-line) review comment.
		case "git:pr:review:comment": {
			let comment = normalizeGithubComment(event.body);
			let bubble = !!comment.body;
			return {
				...base,
				role: "system",
				chunks: [
					{
						kind: "pr-review-comment",
						pr: event.pr,
						author: event.author,
						path: event.path,
						line: event.line,
						url: event.url,
						bubble,
					},
					...(bubble ? [{ kind: "text" as const, raw: comment.body }] : []),
				],
			};
		}

		// Git: entry-point issue opened (title + body imported as a bubble).
		case "git:issue:new": {
			let title = event.title?.trim();
			let body = normalizeGithubComment(event.body ?? "").body;
			let raw = title ? (body ? `**${title}**\n\n${body}` : `**${title}**`) : body;
			return {
				...base,
				role: "system",
				chunks: [
					{ kind: "issue", issue: event.issue, author: event.author, url: event.url },
					...(raw ? [{ kind: "text" as const, raw }] : []),
				],
			};
		}

		// Git: comment on the entry-point issue.
		case "git:issue:comment": {
			let comment = normalizeGithubComment(event.body);
			return {
				...base,
				role: "system",
				chunks: [
					{ kind: "issue-comment", issue: event.issue, author: event.author, url: event.url },
					...(comment.body ? [{ kind: "text" as const, raw: comment.body }] : []),
				],
			};
		}

		// Git: entry-point issue closed or reopened.
		case "git:issue:state":
			return {
				...base,
				role: "system",
				chunks: [{
					kind: "issue-update",
					issue: event.issue,
					url: event.url ?? issueUrl(project, event.issue),
					value: event.value,
				}],
			};

		// User joined or left the channel.
		case "user:join":
			return {
				...base,
				role: "system",
				chunks: [{ kind: "presence", action: "join", sender: event.sender.display }],
			};
		case "user:leave":
			return {
				...base,
				role: "system",
				chunks: [{ kind: "presence", action: "leave", sender: event.sender.display }],
			};

		// Voice/video call started or ended.
		case "call:start":
			return {
				...base,
				role: "system",
				chunks: [{ kind: "call", action: "start", sender: String(event.sender) }],
			};
		case "call:end":
			return {
				...base,
				role: "system",
				chunks: [{ kind: "call", action: "end", sender: String(event.sender) }],
			};

		default:
			return null;
	}
}

// -- Message grouping --

/**
 * Check if two rows belong in the same visual group.
 * Both must be chat messages (not system), same role, same sender, within 5 minutes.
 */
function isSameGroup(a: Row, b: Row, ta: number, tb: number): boolean {
	if (a.role === "system" || b.role === "system") return false;
	if (a.role !== b.role) return false;
	if (a.sender !== b.sender) return false;
	if (a.run !== b.run) return false;
	return Math.abs(ta - tb) < GROUP_WINDOW;
}

// -- Agent turn analysis --

/**
 * Collect files edited by tool calls, with addition/deletion line counts.
 * Skips plan.md (internal planning artifact, not a real file change).
 */
function collectFiles(items: WorkingItem[]): EditedFile[] {
	let files = new Map<string, EditedFile>();

	for (let item of items) {
		if (item.type !== "tools") continue;
		for (let tool of item.tools) {
			if (!editsFile(tool)) continue;

			let path = tool.args ? repoPath(tool.args) : undefined;
			if (!path || isPlan(path)) continue;

			let file = files.get(path);
			if (!file) {
				file = { path, name: basename(path) };
				files.set(path, file);
			}

			let stats = diffStats(tool.result);
			if (stats) {
				file.adds = (file.adds ?? 0) + stats.adds;
				file.dels = (file.dels ?? 0) + stats.dels;
			}
		}
	}

	return [...files.values()];
}

function collectArtifacts(rows: Row[], items: WorkingItem[]): Artifact[] {
	let artifacts = new Map<string, Artifact>();

	let add = (artifact: Artifact) => {
		let key = artifactKey(artifact);
		if (!artifacts.has(key)) artifacts.set(key, artifact);
	};

	for (let row of rows) {
		for (let chunk of row.chunks) {
			if (chunk.kind !== "file") continue;
			if (isPlan(chunk.name)) continue;
			let path = repoPath(chunk.name);
			add({
				kind: "document",
				title: basename(path ?? chunk.name),
				meta: "Created document",
				path,
				url: chunk.url,
			});
		}
	}

	for (let item of items) {
		if (item.type !== "tools") continue;
		for (let tool of item.tools) {
			if (!successful(tool)) continue;

			let path = tool.args ? repoPath(tool.args) : undefined;
			if (createsFile(tool) && path && isDocument(path) && !isPlan(path)) {
				add({
					kind: "document",
					title: basename(path),
					meta: "Created document",
					path,
				});
			}

			let issue = issueArtifact(tool);
			if (issue) add(issue);
			let pr = pullRequestArtifact(tool);
			if (pr) add(pr);
			let comment = commentArtifact(tool);
			if (comment) add(comment);
			let label = labelArtifact(tool);
			if (label) add(label);
		}
	}

	return [...artifacts.values()];
}

function artifactKey(artifact: Artifact): string {
	if (artifact.kind === "document") {
		let path = artifact.path ? repoPath(artifact.path) : undefined;
		if (path) return `${artifact.kind}:path:${path}`;
		return `${artifact.kind}:title:${artifact.title}`;
	}

	if (artifact.url) return `${artifact.kind}:url:${artifact.url}`;
	if (artifact.path) return `${artifact.kind}:path:${artifact.path}`;
	if (artifact.number !== undefined) {
		return `${artifact.kind}:target:${artifact.meta}:${artifact.number}:${artifact.title}`;
	}
	return `${artifact.kind}:title:${artifact.title}`;
}

function diffStats(result?: string): { adds: number; dels: number } | undefined {
	if (!result || !/^---\s|\ndiff --git\s|\n@@\s/m.test(result)) return;

	let adds = 0;
	let dels = 0;
	for (let line of result.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) adds++;
		else if (line.startsWith("-")) dels++;
	}

	return adds || dels ? { adds, dels } : undefined;
}

function successful(tool: ToolNode): boolean {
	return tool.status === "success";
}

function compact(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resultUrl(text: string): string | undefined {
	return text.match(/https:\/\/\S+/)?.[0];
}

type ArtifactTarget = "Issue" | "PR";

type CreatedResult = {
	number?: number;
	title?: string;
	url?: string;
};

type CommentResult = {
	target: ArtifactTarget;
	number: number;
	title?: string;
};

type LabelResult = {
	action: "Added" | "Removed";
	target?: ArtifactTarget;
	number: number;
	labels: string[];
};

function issueArtifact(tool: ToolNode): Artifact | undefined {
	if (!/^ace_create_issue$/i.test(tool.name)) return;

	let text = tool.result || "";
	let created = parseCreatedIssue(text);
	let title = inputString(tool, "title") || created?.title;
	if (!title || !created?.number) return;

	return {
		kind: "issue",
		title,
		meta: `Created issue #${created.number}`,
		url: created.url || resultUrl(text),
		number: created.number,
	};
}

function pullRequestArtifact(tool: ToolNode): Artifact | undefined {
	let name = compact(tool.name);
	if (!/(createpr|createpullrequest|ghprcreate|openpr|openpullrequest)/.test(name)) return;

	let text = tool.result || "";
	let created = parseCreatedPullRequest(text);
	let title = inputString(tool, "title") || created?.title;
	if (!title || !created?.number) return;
	return {
		kind: "pull-request",
		title,
		meta: `Created pull request #${created.number}`,
		url: created.url || resultUrl(text),
		number: created.number,
	};
}

function commentArtifact(tool: ToolNode): Artifact | undefined {
	let name = compact(tool.name);
	if (!/(comment|reply)/.test(name)) return;

	let text = tool.result || "";
	let comment = commentResult(tool, text);
	if (!comment) return;
	let title = inputString(tool, "body") || comment.title || tool.args?.trim()
		|| `Comment on ${comment.target} #${comment.number}`;
	return {
		kind: "comment",
		title,
		meta: `Added comment to ${targetName(comment.target)} ${comment.number}`,
		url: resultUrl(text),
		number: comment.number,
	};
}

function labelArtifact(tool: ToolNode): Artifact | undefined {
	let name = compact(tool.name);
	if (!/label/.test(name)) return;

	let text = tool.result || "";
	let label = labelResult(tool, text);
	if (!label) return;
	let verb = label.action.toLowerCase();
	let relation = verb === "removed" ? "from" : "to";
	let plural = label.labels.length !== 1;
	return {
		kind: "label",
		title: label.labels.join(", "),
		meta: `${label.action} label${plural ? "s" : ""} ${relation} ${
			targetReference(label.target, label.number)
		}`,
		url: resultUrl(text),
		number: label.number,
	};
}

function parseCreatedIssue(text: string): CreatedResult | undefined {
	let match = text.match(/Created issue #(\d+):\s*([^\n]+)(?:\n(\S+))?/i);
	if (!match) return;
	return {
		number: Number(match[1]),
		title: cleanTitle(match[2]),
		url: match[3],
	};
}

function parseCreatedPullRequest(text: string): CreatedResult | undefined {
	let match = text.match(/Created (?:pull request|PR) #(\d+):?\s*([^\n]*)/i);
	if (!match) return;
	return {
		number: Number(match[1]),
		title: cleanTitle(match[2]),
		url: resultUrl(text),
	};
}

function commentResult(tool: ToolNode, text: string): CommentResult | undefined {
	if (!resultSucceeded(text)) return parseCommentResult(text);

	let number = inputNumber(tool, "pull_number");
	if (number) return { target: "PR", number };

	number = inputNumber(tool, "issue_number");
	if (number && /^ace_comment_on_issue$/i.test(tool.name)) return { target: "Issue", number };

	return parseCommentResult(text);
}

function parseCommentResult(text: string): CommentResult | undefined {
	let legacy = text.match(
		/(?:Commented on|Replied to|Created comment on|Added comment to)\s+(issue|PR|pull request)\s+#(\d+):?[ \t]*([^\n]*)/i,
	);
	if (legacy) {
		return {
			target: targetFrom(legacy[1]!),
			number: Number(legacy[2]),
			title: legacy[3]?.trim(),
		};
	}

	let live = text.match(/Comment added to\s+(PR\s+)?#(\d+)/i);
	if (!live) return;
	return {
		target: live[1] ? "PR" : "Issue",
		number: Number(live[2]),
	};
}

function labelResult(tool: ToolNode, text: string): LabelResult | undefined {
	if (!resultSucceeded(text)) return parseLabelResult(text);

	let labels = inputStrings(tool, "labels");
	let number = inputNumber(tool, "issue_number");
	if (labels?.length && number && /^ace_add_labels$/i.test(tool.name)) {
		return {
			action: "Added",
			number,
			labels,
		};
	}

	return parseLabelResult(text);
}

function parseLabelResult(text: string): LabelResult | undefined {
	let legacy = text.match(
		/(Added|Removed) label [`'"]?([^`'"\n]+?)[`'"]? (?:to|from) (issue|PR|pull request) #(\d+)/i,
	);
	if (legacy) {
		return {
			action: labelAction(legacy[1]!),
			target: targetFrom(legacy[3]!),
			number: Number(legacy[4]),
			labels: [legacy[2]!.trim()],
		};
	}

	let live = text.match(/(Added|Removed) labels? \[([^\]\n]+)\] (?:to|from) #(\d+)/i);
	if (!live) return;
	return {
		action: labelAction(live[1]!),
		number: Number(live[3]),
		labels: live[2]!.split(",").map(label => label.trim()).filter(Boolean),
	};
}

function targetFrom(value: string): ArtifactTarget {
	return value.toLowerCase().startsWith("issue") ? "Issue" : "PR";
}

function targetName(target: ArtifactTarget): string {
	return target === "PR" ? "PR" : "issue";
}

function targetReference(target: ArtifactTarget | undefined, number: number): string {
	return target ? `${targetName(target)} ${number}` : `#${number}`;
}

function labelAction(value: string): "Added" | "Removed" {
	return value.toLowerCase() === "removed" ? "Removed" : "Added";
}

function inputString(tool: ToolNode, key: string): string | undefined {
	let value = tool.input?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inputNumber(tool: ToolNode, key: string): number | undefined {
	let value = tool.input?.[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return;
	let number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function inputStrings(tool: ToolNode, key: string): string[] | undefined {
	let value = tool.input?.[key];
	if (!Array.isArray(value)) return;
	let strings = value.filter((item): item is string => typeof item === "string" && !!item.trim())
		.map(item => item.trim());
	return strings.length ? strings : undefined;
}

function cleanTitle(value: string | undefined): string | undefined {
	let title = value?.trim();
	if (!title || /^[^\p{L}\p{N}]+$/u.test(title)) return;
	return title;
}

function resultSucceeded(text: string): boolean {
	let result = text.trim();
	return !!result && !/^Error:/i.test(result);
}

/**
 * Build the agent turn structure for a message group.
 *
 * Splits rows into:
 * - working items: intermediate text and tool calls shown in a collapsible section
 * - final message: the last text-only row, shown outside the collapsible
 *
 * The last row is "final" only if it has text content, no tool calls, and the
 * agent is no longer working. Live deltas stay in the working context because
 * the backend does not distinguish interim narration from final-answer text.
 */
function buildTurn(group: Group, working: boolean): AgentTurn {
	let items: WorkingItem[] = [];
	let final: Row | undefined;

	// Separate the final text-only response from working items.
	// The final row is the last one with text but no tools — only when agent is done.
	let last = group.rows[group.rows.length - 1];
	let hasTools = last && last.chunks.some(c => c.kind === "tool-group");
	let hasText = last && last.chunks.some(c => c.kind === "text");

	let rows: Row[];
	if (!working && !hasTools && hasText) {
		final = { ...last, streaming: false };
		rows = group.rows.slice(0, -1);
	} else {
		rows = group.rows;
	}

	// Build working items from intermediate rows.
	for (let row of rows) {
		let text: Chunk[] = [];
		let tools: ToolNode[] = [];
		let texts = 0;
		let groups = 0;
		let intents = 0;

		let flushText = () => {
			if (!text.length) return;
			let id = texts === 0 ? row.uid + ":text" : row.uid + ":text:" + texts;
			items.push({
				type: "text",
				id,
				uid: row.uid,
				chunks: text,
				reactions: row.reactions,
			});
			text = [];
			texts++;
		};

		let flushTools = () => {
			if (!tools.length) return;
			let id = groups === 0 ? row.uid + ":tools" : row.uid + ":tools:" + groups;
			let prev = items.at(-1);
			if (prev?.type === "tools") {
				prev.tools = prev.tools.concat(tools);
				prev.summary = summarizeTools(prev.tools);
				prev.caption = captionTools(prev.tools);
			} else {
				items.push({
					type: "tools",
					id,
					uid: row.uid,
					summary: summarizeTools(tools),
					caption: captionTools(tools),
					tools,
				});
			}
			tools = [];
			groups++;
		};

		let pushIntent = (raw: string) => {
			flushTools();
			items.push({
				type: "text",
				id: row.uid + ":intent:" + intents,
				uid: row.uid,
				chunks: [{ kind: "text", raw }],
			});
			intents++;
		};

		let appendTool = (tool: ToolNode) => {
			if (tool.name === "report_intent") {
				flushText();
				if (tool.args) pushIntent(tool.args);
				if (tool.children) appendTools(tool.children);
				return;
			}

			flushText();
			tools.push(tool);
		};

		let appendTools = (list: ToolNode[]) => {
			for (let tool of list) appendTool(tool);
		};

		for (let chunk of row.chunks) {
			if (chunk.kind === "tool-group") appendTools(chunk.tools);
			else {
				flushTools();
				text.push(chunk);
			}
		}

		flushText();
		flushTools();
	}

	let files = final ? collectFiles(items) : [];
	let artifacts = final ? collectArtifacts(group.rows, items) : [];
	let start = rows[0]?.ts ?? group.ts;
	let end = final?.ts ?? rows.at(-1)?.ts ?? group.ts;

	let tools = items.flatMap(item => item.type === "tools" ? item.tools : []);
	let summary = items.length ? summarizeWorkingTools(tools, start, end) : "No working context";
	return { summary, working: items, final, files, artifacts };
}

// -- Main reducer --

/**
 * Compile a stream of events into a structured timeline.
 *
 * Produces a flat list of timeline items:
 * - Message groups: consecutive same-sender rows within a 5-minute window.
 *   Avatar and byline shown once per group. Later rows set `grouped: true`.
 * - System events: standalone items that break message groups.
 *   Never grouped with anything else.
 *
 * Agent groups additionally get an AgentTurn with:
 * - Working items (collapsible intermediate text + tools)
 * - Final response (shown outside the collapsible)
 * - Edited files and artifacts once the final response exists
 */
function compile(
	events: Event[],
	working: TimelineWorking = false,
	project?: REPO,
): TimelineItem[] {
	let items: TimelineItem[] = [];
	let current: { group: Group; ts: number } | null = null;
	let ts = 0;
	let lastDay: number | null = null;
	let aborted = new Set<string>();

	for (let event of events) {
		if (event.type === "exec:abort") aborted.add(event.target.uid);
	}

	let flush = (active = false) => {
		if (!current) return;
		let { group } = current;
		// Agent groups get the full turn analysis (intent, working/final split, file pills).
		let ongoing = typeof working === "object" ? group.run === working.run : active;
		let turn = group.role === "assistant" ? buildTurn(group, ongoing) : undefined;
		items.push({ kind: "group", group, turn });
		current = null;
	};

	for (let event of events) {
		let row = eventToRow(event, project, event.type === "exec" && aborted.has(event.uid));
		if (!row) continue;
		ts = event.created_at;

		// Insert a day divider whenever the calendar date rolls over.
		let day = dayStart(ts);
		if (day !== lastDay) {
			flush(false);
			items.push({ kind: "day", ts: day });
			lastDay = day;
		}

		// System events always break the current group and stand alone.
		if (row.role === "system") {
			flush(false);
			items.push({ kind: "event", row });
			continue;
		}

		// Start a new group or extend the current one.
		if (
			current
			&& isSameGroup(current.group.rows[current.group.rows.length - 1]!, row, current.ts, ts)
		) {
			row.grouped = true;
			current.group.rows.push(row);
			current.group.ts = ts;
			current.ts = ts;
		} else {
			flush(false);
			current = {
				group: {
					id: row.uid,
					role: row.role as "user" | "assistant",
					sender: row.sender,
					display: row.display,
					run: row.run,
					rows: [row],
					ts,
				},
				ts,
			};
		}
	}

	flush(working === true);

	// If the agent is still working and the last item isn't an agent group,
	// append an empty assistant group so the UI can show a thinking indicator.
	if (working) {
		let last = items[items.length - 1];
		let lastIsAgent = last?.kind === "group" && last.group.role === "assistant"
			&& (typeof working === "boolean" || last.group.run === working.run);
		if (!lastIsAgent) {
			let active = typeof working === "object" ? working : undefined;
			let group: Group = {
				id: active ? `__thinking:${active.run}` : "__thinking",
				role: "assistant",
				sender: active?.sender.value,
				display: active?.sender.display,
				run: active?.run,
				rows: [],
				ts,
			};
			items.push({
				kind: "group",
				group,
				turn: { summary: "No working context", working: [], files: [], artifacts: [] },
			});
		}
	}

	return items;
}

export { compile, merge, structure };
export type {
	AgentTurn,
	Artifact,
	Chunk,
	EditedFile,
	Group,
	ImageNode,
	Row,
	TimelineItem,
	TimelineWorking,
	WorkingItem,
};
export type { Status, ToolGroup, ToolKind, ToolNode } from "./tool-summary";
