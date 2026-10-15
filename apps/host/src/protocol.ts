/** The host gateway's wire contract: JSON messages over one WebSocket per client. */
import type {
	ChannelInfo,
	Event,
	GithubFilter,
	GithubKind,
	ModelRef,
	Request,
	RunEnd,
} from "@ace/channel/protocol";

export const HOST_PROTOCOL = 9;

/** A watch's `closed` reason when the channel's worker or hosting service ended it, as a restart does. */
export const CHANNEL_CLOSED = "The channel closed the connection";

export type HostInfo = {
	app: "ace";
	protocol: number;
	home: string;
	pid: number;
	helper: boolean;
};

/** A place a channel can move to: "local" for this host, or a hosting service's base URL. */
export type MoveTarget = { target: string; label: string };

export type WorkerInfo = { id: string; pid: number };
/** `freeze` drains admitted requests and exits the worker for a move, or fails if work remains. */
export type WorkerRequest = { op: "worker" } | { op: "freeze" };

export type Diagnostics = {
	tools: { name: string; path?: string; version?: string; error?: string }[];
	tailscale: {
		state: "missing" | "offline" | "running" | "error";
		name?: string;
		error?: string;
	};
	directory: { url?: string; synced?: number; error?: string };
	/** Whether the helper loaded the login shell's environment; `pending` while it retries. */
	shell: { state: "adopted" | "pending" | "failed"; error?: string };
};

/** `offline`: the channel's host is unreachable. Hosted channels are never offline. */
export type ChannelState = "running" | "dormant" | "archived" | "offline";

export type Listing = {
	id: string;
	/** The machine running the channel, by its tailnet name. */
	host: string;
	name: string;
	/**
	 * The channel's original name, which stays unique on its host across renames. Messages its agent
	 * sends other channels are authored `agent@<prefix>`. Older hosts omit it.
	 */
	prefix?: string;
	summary?: string;
	/** Revision of the channel's projected name and summary. */
	revision?: number;
	owner: string;
	/** The checkout the channel works in, which may be a Git worktree of its project. */
	project: string;
	/** The project `project` belongs to: its repository's main checkout on the channel's host. */
	root?: string;
	/** The project's GitHub repository as owner/name. */
	repo?: string;
	model?: ModelRef;
	created: number;
	/** When the transcript last grew; hosts on older builds omit it. */
	active?: number;
	/** Live channel-wide run projection; absent on older hosts, never authoritative. */
	busy?: boolean;
	/** The latest invoked run's end; absent on older hosts and before a channel's first one. */
	ran?: RunEnd;
	state: ChannelState;
	/** The hosting service's base URL, for a hosted channel; `host` is then its workspace. */
	hosted?: string;
};

/** Channels idle this long are inactive until their transcript grows again. */
const INACTIVE_AFTER = 6 * 60 * 60_000;

/** The sidebar's Inactive group and the host's Archive inactive share this definition. */
export function isInactive(
	channel: Pick<Listing, "busy" | "active" | "created">,
	now: number,
): boolean {
	return !channel.busy && now - (channel.active || channel.created) > INACTIVE_AFTER;
}

/** `github` is the host owner's GitHub login, when its GitHub CLI is signed in. */
export type Hello = { user: string; host: string; github?: string };

/** GitHub logins by participant (Tailscale login), from this host, its peers, and the directory. */
export type People = Record<string, string>;

/** Tabs belong to a connected client's layout, not the durable channel. */
export type Tab = {
	id: string;
	name: string;
	type: "blank" | "chat" | "diff" | "terminal";
	/** Selected in its pane; split layouts can show several active tabs. */
	active: boolean;
};

export type WindowState = { channel: { id: string; name: string }; tabs: Tab[] };
export type WindowInfo = WindowState & { id: string };
export type TabRename = {
	call: string;
	channel: string;
	tab: string;
	name: string;
	expires: number;
};
export type TabResult = { ok: true; value: WindowState } | { ok: false; error: string };

/** A folder opened on this host, independent of its channels and provider setup. */
export type Project = {
	/** The repository's main checkout, or the folder itself outside Git. */
	path: string;
	name: string;
	/** The GitHub repository as owner/name. */
	repo?: string;
	/** False until the folder is a Git repository with a commit, which lanes start from. */
	git?: false;
};

export type ProviderId = "anthropic" | "openai";

export type CredentialStatus = {
	source: "keychain" | "environment" | "missing" | "unavailable";
	stored: boolean | null;
	override?: string;
	error?: string;
};

export type ProviderSettings = CredentialStatus & { id: ProviderId; name: string };

export type Settings = {
	providers: ProviderSettings[];
	model: ModelRef | null;
	modelOverride?: ModelRef;
	models: ModelRef[];
	error?: string;
};

export type HostRequest =
	| { op: "hello" }
	/** Publish this local client's current channel layout, or unregister it. */
	| { op: "window"; value: WindowState | null }
	/** Connected channel windows on the owner's local gateway. */
	| { op: "windows" }
	| { op: "tab-rename"; window: string; channel: string; tab: string; name: string }
	/** Only the window that received a rename can acknowledge it. */
	| { op: "tab-result"; call: string; result: TabResult }
	| { op: "channels" }
	| { op: "projects" }
	| { op: "project-open"; path: string }
	/** Initialize Git in an opened folder and commit its current files. */
	| { op: "project-init"; path: string }
	/**
	 * Clone a known GitHub project into `path` on this host, or open the matching checkout already
	 * there, then add it like `project-open`. The host expands `~`.
	 */
	| { op: "project-clone"; repo: string; path: string }
	/** Resolve a known project's GitHub remote on the machine that holds its checkout. */
	| { op: "project-repo"; project: string; host?: string }
	/** GitHub reads use the local owner's GitHub CLI credentials, never a peer's account. */
	| {
		op: "github-list";
		repo: string;
		kind: GithubKind;
		state: GithubFilter;
		search: string;
		limit: number;
	}
	| { op: "github-detail"; repo: string; kind: GithubKind; number: number }
	| { op: "github-files"; repo: string; number: number }
	| { op: "github-pull"; repo: string; branch: string }
	/** These settings belong to the local owner and are never forwarded to peers. */
	| { op: "settings" }
	| { op: "diagnostics" }
	| { op: "key-set"; provider: ProviderId; value: string }
	| { op: "key-check"; provider: ProviderId }
	| { op: "key-remove"; provider: ProviderId }
	| { op: "preferences"; model: ModelRef | null }
	/** Quiesce this helper before replacing its application, or recover a canceled update. */
	| { op: "update-prepare" }
	| { op: "update-cancel" }
	/** Models with credentials on a host; this host when omitted. */
	| { op: "models"; host?: string }
	/** Owner actions; tailnet peers create, archive, and delete channels on their own hosts. */
	| { op: "create"; project: string; name?: string; model?: ModelRef }
	| { op: "archive"; channel: string; archived: boolean }
	/** Archive the project's channels on this host that have no work in progress. */
	| { op: "archive-inactive"; project: string }
	| { op: "delete"; channel: string }
	/** Where the owner can move one of this host's idle channels: "local" or a hosting service URL. */
	| { op: "move-targets"; channel: string }
	/** Resolves once the channel runs at `target`; its watches end and reattach there. */
	| { op: "move"; channel: string; target: string }
	/**
	 * Forward a request to a channel on this host or a peer, starting its worker if dormant. The
	 * channel's host sets every author field to the participant it verified. A `watch` streams
	 * events until a failure frame for its id follows the accepted reply: after `release`, or when
	 * the channel's worker or a relaying host closes. Clients that predate this frame drop it.
	 */
	| { op: "channel"; channel: string; request: Request }
	/**
	 * Open a terminal in a chat's working directory, or reattach to `terminal` and replay its recent
	 * output. Only for channels whose workspace is this host. Output arrives as terminal frames; a
	 * terminal outlives its clients until closed, its shell exits, or it sits unattached too long.
	 */
	| {
		op: "terminal";
		channel: string;
		chat?: number;
		terminal?: string;
		cols: number;
		rows: number;
	}
	/** Keystrokes and pasted text, as UTF-8. */
	| { op: "terminal-input"; terminal: string; data: string }
	| { op: "terminal-resize"; terminal: string; cols: number; rows: number }
	| { op: "terminal-close"; terminal: string }
	/** Drop this client's connection to a channel, ending its watches. */
	| { op: "release"; channel: string };

/** `trace` follows a request through every host and worker that relays it. */
export type HostEnvelope = { id: number; trace?: string } & HostRequest;

export type HostFrame =
	| { id: number; ok: true; value: unknown }
	| { id: number; ok: false; error: string }
	| { id: number; event: Event }
	| { rename: TabRename }
	/** Local settings changed; clients reload model availability without receiving secrets. */
	| { settings: true }
	/** Opened projects belong to the local owner and are never sent to tailnet peers. */
	| { projects: Project[] }
	/** Sent to local clients when known GitHub logins change. */
	| { people: People }
	/**
	 * Pushed when any reachable host's catalog changes. A local client sees every reachable host's
	 * channels; a tailnet peer sees only this host's.
	 */
	| { channels: Listing[] }
	| TerminalFrame;

/**
 * Terminal output as base64, since a chunk can split a UTF-8 sequence; then its exit code. A
 * reattach starts with one `replay` frame of earlier output, whose queries must not be answered.
 */
export type TerminalFrame =
	| { terminal: string; data: string; replay?: true }
	| { terminal: string; exit: number };

export type TerminalOpened = { terminal: string; cwd: string };

export type { ChannelInfo, Event, ModelRef, Request };
