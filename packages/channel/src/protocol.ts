import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** The wire contract between a channel and its clients: one JSON value per line. */

export type ModelRef = { provider: string; modelId: string };
/** "off" leaves always-thinking providers at their default; otherwise disables reasoning. */
export type Effort = ModelThinkingLevel;
export type ModelOption = ModelRef & { efforts: Effort[] };

/** Cumulative usage for one chat, including compaction and usage reported by tools. */
export type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	/** Estimated USD at the model catalog's prices. */
	cost: number;
};

/** pi conversation and entry IDs. */
export type ChatId = number;
export type EntryId = number;

export type Metadata = { name: string; summary: string; revision: number };

/**
 * The end of a run a person invoked. `stopped` means a participant aborted it; `author` is the
 * participant whose input the run answered last.
 */
export type RunEnd = {
	chat: ChatId;
	at: number;
	outcome: "done" | "failed" | "stopped";
	author: string;
};

export type ChannelInfo = Metadata & {
	id: string;
	/** Directory of the project checkout lanes are created from. */
	project: string;
	owner: string;
	/** Whether participants other than the owner may invoke agents. */
	shared: boolean;
	/** Channel-wide native desktop tools gate, including the owner's agents and child chats. */
	desktop: boolean;
	chats: Chat[];
};

export type Chat = {
	id: ChatId;
	/** The chat whose agent created this one as a subagent. */
	parent?: ChatId;
	busy: boolean;
	model?: ModelRef;
	effort?: Effort;
	lane?: string;
	/** The lane's worktree, present with `lane`. */
	cwd?: string;
	/** Older hosts may not report usage. */
	usage?: Usage;
	/**
	 * How full the model's context window is: the latest response's tokens, as its provider
	 * reported them. Absent before the first response.
	 */
	context?: { used: number; window: number };
};

/** A file the chat's work changed, relative to `Changes.cwd`. */
export type Change = {
	file: string;
	from?: string;
	binary: boolean;
	adds: number;
	dels: number;
	/** The worktree file's version, independent of its diff's line counts. */
	version: string;
	/**
	 * Committed on the checkout's branch since its base, or only on disk. A file can be listed
	 * once committed and again uncommitted. Older hosts omit it and list each file once against
	 * the base.
	 */
	state?: "committed" | "uncommitted" | "untracked";
};

/**
 * What a chat's work changed: its lane's commits since it forked from the lane's base, as a pull
 * request into that base would show them, then uncommitted and untracked files. A chat without a
 * lane has no committed changes.
 */
export type Changes = {
	lane?: string;
	/** The checked-out branch; absent when HEAD is detached. */
	branch?: string;
	cwd: string;
	base: string;
	head: string;
	files: Change[];
	/** Untracked directories too large to list file by file. */
	dirs?: { dir: string; files: number }[];
};

/** GitHub views are read through the host; they are not durable channel state. */
export type GithubKind = "issues" | "prs";
export type GithubFilter = "open" | "closed" | "all";
export type GithubItem = {
	kind: GithubKind;
	number: number;
	title: string;
	url: string;
	state: "open" | "closed" | "merged" | "draft";
	author: string;
	created: string;
	updated: string;
	labels: { name: string; color: string }[];
};
export type GithubList = { items: GithubItem[]; more: boolean };
export type GithubCheck = {
	name: string;
	url?: string;
	state: "pending" | "passed" | "failed" | "skipped";
};
/** The newest pull request from a branch, with its latest check results. */
export type GithubPull = GithubItem & { checks: GithubCheck[] };
export type GithubComment = {
	id: string;
	url: string;
	author: string;
	body: string;
	created: string;
	review?: "approved" | "changes_requested" | "commented" | "dismissed";
};
export type GithubDetail = GithubItem & {
	body: string;
	comments: GithubComment[];
	pull?: {
		base: string;
		head: string;
		adds: number;
		dels: number;
		files: number;
		review: string;
	};
};
export type GithubFile = {
	file: string;
	from?: string;
	adds: number;
	dels: number;
	signature: string;
	patch?: string;
	error?: string;
};

/** An image as base64. Clients downscale before sending; see `MAX_IMAGES` in room.ts. */
export type Image = { mimeType: string; data: string };

/** A message admitted by pi but not yet placed in the chat's transcript. */
export type QueuedMessage = {
	submission: number;
	author: string;
	text: string;
	images?: Image[];
	invoked: boolean;
};

export type Request =
	| { op: "info" }
	| { op: "models" }
	/** Post to the chat without invoking its agent. */
	| {
		op: "say";
		chat?: ChatId;
		author: string;
		text: string;
		images?: Image[];
		requestId?: string;
	}
	/** Post to the chat and invoke its agent; a busy chat takes the message as steering. */
	| {
		op: "ask";
		chat?: ChatId;
		author: string;
		text: string;
		images?: Image[];
		model?: ModelRef;
		effort?: Effort;
		requestId?: string;
	}
	| { op: "chat"; author: string; model?: ModelRef }
	| { op: "stop"; chat?: ChatId }
	| { op: "kill" }
	| { op: "share"; author: string; shared: boolean }
	| { op: "desktop"; author: string; enabled: boolean }
	| { op: "rename"; author: string; name: string }
	/** Resolve once the answer to a submission is placed: "done", or "unanswered" when stopped or killed. */
	| { op: "wait"; submission: number }
	| { op: "changes"; chat?: ChatId }
	/** One listed file's unified diff; without `state`, its worktree against the base. */
	| { op: "patch"; chat?: ChatId; file: string; state?: Change["state"] }
	/** Replay the chat's transcript, then stream its events until the connection closes. */
	| {
		op: "watch";
		chat?: ChatId;
		/** Include queue events; older clients do not understand them. */
		queue?: boolean;
		/** Include caption and recap events; older clients do not understand them. */
		captions?: boolean;
		/** Include progress events; older clients do not understand them. */
		progress?: boolean;
	};

export type Event =
	/** The complete current message queue, sent on attachment and every committed change. */
	| { kind: "queue"; chat: ChatId; messages: QueuedMessage[] }
	/** A human message; `invoked` when it asked the chat's agent to run. */
	| {
		kind: "message";
		chat: ChatId;
		entry: EntryId;
		at: number;
		author: string;
		text: string;
		images?: Image[];
		invoked: boolean;
	}
	/** `error` when the provider failed the response; `stopped` when someone stopped it. */
	| {
		kind: "reply";
		chat: ChatId;
		entry: EntryId;
		at: number;
		model: string;
		text: string;
		error?: string;
		stopped?: boolean;
	}
	/** Streamed text of the reply being generated; the next `reply` replaces it. */
	| { kind: "delta"; chat: ChatId; text: string }
	| {
		kind: "tool";
		chat: ChatId;
		at: number;
		model: string;
		call: string;
		name: string;
		args: unknown;
	}
	/**
	 * The bounded tail of a running tool call's output, sent on attachment and as it grows, at most
	 * every half second. Each replaces the call's previous one; its `result` supersedes them all.
	 * `truncated` when earlier output is not shown. Not stored: only pi's live state backs it.
	 */
	| { kind: "progress"; chat: ChatId; call: string; text: string; truncated?: boolean }
	/** `interrupted` when the channel restarted while the tool ran, so it may have partially run. */
	| {
		kind: "result";
		chat: ChatId;
		call: string;
		error: boolean;
		text: string;
		images?: Image[];
		stopped?: boolean;
		interrupted?: boolean;
	}
	/**
	 * A fast model's one-line description of a group of consecutive tool calls, sent on attachment
	 * and whenever a group is captioned again. Clients show it for whichever group holds `calls`.
	 */
	| { kind: "caption"; chat: ChatId; calls: string[]; text: string }
	/**
	 * A stronger model's summary of all the work after a human message, sent on attachment and
	 * once the work ends. Clients show it for whichever agent turn holds `calls`.
	 */
	| { kind: "recap"; chat: ChatId; calls: string[]; text: string }
	| { kind: "run"; chat: ChatId; state: "start" | "end" }
	/**
	 * Channel-wide metadata, sent initially and whenever its name, summary, or settings change.
	 * `revision` covers only the name and summary. Older hosts omit `shared` and `desktop`;
	 * missing settings do not establish support for changing them.
	 */
	| ({ kind: "metadata"; chat: ChatId; shared?: boolean; desktop?: boolean } & Metadata)
	/** The replayed transcript has been sent; later events are live. */
	| { kind: "live"; chat: ChatId };

export type Frame =
	| { id: number; ok: true; value: unknown }
	| { id: number; ok: false; error: string }
	| { id: number; event: Event };

/** `trace` ties a request's log lines together across the processes that relay it. */
export type Envelope = { id: number; trace?: string } & Request;

/** A message one channel's agent sends to another channel. */
export type Delivery = {
	channel: string;
	chat?: ChatId;
	author: string;
	text: string;
	invoke: boolean;
	requestId: string;
};
