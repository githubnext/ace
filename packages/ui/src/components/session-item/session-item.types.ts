import type { Capabilities, UNIX } from "../../types";

/**
 * The data a single sidebar row reads.
 */
export type SidebarRow = {
	// Opaque presentation keys; persisted cell IDs belong to the runtime, not the sidebar.
	uid: string;
	kind: "session" | "lobby";
	renderKey?: string;
	name: string;
	summary?: string;
	parent?: string;
	depth?: number;
	createdAt: UNIX;

	// Lifecycle (orthogonal to connectivity)
	lifecycle: "creating" | "live" | "archived" | "deleting";
	creating?: {
		sessionUid?: string;
		settled?: boolean;
	};

	// Permissions / role
	private: boolean;
	/** Runs on the team's cloud compute rather than a teammate's machine. */
	cloud?: boolean;
	mine: boolean;
	member: boolean;
	/** Omitted by local/legacy callers; explicit peer policy controls administrative actions. */
	capabilities?: Capabilities;

	// Connectivity (only meaningful when lifecycle === "live")
	// "warming": the transport is open but the session has not proven it is serving yet.
	connection:
		| "connected"
		| "connecting"
		| "warming"
		| "reconnecting"
		| "error"
		| "idle"
		| "offline";
	/** The machine running the channel, which an offline row names. */
	host?: string;
	/** Its cloud workspace is stopped; the chat stays readable and Start compute resumes it. */
	stopped?: boolean;

	// Agent (only meaningful while connection === "connected")
	agent: "idle" | "thinking" | "tool" | "streaming" | "aborting";

	// Workstream
	pr?: {
		state: "draft" | "open" | "closed" | "merged";
		ci: "none" | "pending" | "passed" | "failed";
		number: `#${number}`;
		url?: string;
		checks?: {
			total: number;
			completed: number;
			failed: number;
		};
	};

	// Conversation (viewer-relative)
	unreadCount: number;
	mentionCount: number;
	needsAttention?: boolean;
	lastSpeaker?: "user" | "agent";
	lastActivityAt: UNIX;

	// Per-session presence (current user excluded), away people last
	online: { id: string; name: string; avatar?: string; away?: boolean }[];

	// Optional / deferred (v1.1)
	hasPlan?: boolean;
	hasSummary?: boolean;
	openTodos?: number;
};

/** A place a channel can move to; `target` is opaque to the sidebar. */
export type MoveTarget = { target: string; label: string };
