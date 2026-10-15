/**
 * The lobby's wire contract: JSON messages over one WebSocket per host and project, at
 * `GET /lobbies/<project ID>`. Hosts are the only lobby clients; apps reach it through their host.
 */

/** A person here in the project, as their host reports them. */
export type Presence = {
	/** GitHub login. Hosts convert their owner's Tailscale login before publishing. */
	login: string;
	/** The reporting host, by its tailnet name. */
	host: string;
	/** The project's channels open in this person's windows on that host. */
	channels: string[];
	/** No focused window on any of them. */
	away: boolean;
};

export type LifecycleKind =
	| "created"
	| "renamed"
	| "summarized"
	| "archived"
	| "resumed"
	| "moved"
	| "deleted";

/**
 * A channel's lifecycle as its host saw it, after publishing to the directory. `listing` is the
 * host's listing after the change, opaque here; deletions carry none. The lobby stamps `host`.
 */
export type Lifecycle<Listing = unknown> = {
	channel: string;
	kind: LifecycleKind;
	at: number;
	host: string;
	listing?: Listing;
};

export type LobbyUp<Listing = unknown> =
	/** First on every socket. `since` is the newest seq the host applied; omitted on its first visit. */
	| { op: "hello"; host: string; since?: number }
	/** This host's whole presence in the project, replacing what it sent before; null when not here. */
	| { op: "presence"; presence: Presence | null }
	| { op: "lifecycle"; event: Omit<Lifecycle<Listing>, "host"> };

export type LobbyDown<Listing = unknown> =
	/** Everyone here, sent on every change. */
	| { kind: "presence"; people: Presence[] }
	| { kind: "lifecycle"; seq: number; event: Lifecycle<Listing> }
	/**
	 * Ends the replay after hello. `resync` means events after `since` are gone, so the host must
	 * read listings again; `seq` is then the newest seq to resume from.
	 */
	| { kind: "synced"; seq: number; resync: boolean };

/** Sent as text; the lobby answers `pong` without waking. */
export const PING = "ping";
export const PONG = "pong";
