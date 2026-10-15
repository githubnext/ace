/** A client of a host gateway, shared by the app and by hosts reaching their tailnet peers. */
import type { Metadata } from "@ace/channel/protocol";

import type {
	Event,
	HostFrame,
	HostRequest,
	Listing,
	People,
	Presence,
	Project,
	Request,
	TabRename,
	TerminalFrame,
	WindowState,
} from "./protocol";

/**
 * A watch's events, then `closed` once an accepted watch ends: released, or its channel connection
 * or a relaying host closed. The owner decides whether to watch again.
 */
export type Watch = { event(event: Event): void; closed?(error: string): void };

type Pending = {
	resolve(value: unknown): void;
	reject(error: Error): void;
	watch?: Watch;
	waiting?(text: string | null): void;
	/** The watch was accepted, so a later failure ends it instead of rejecting the request. */
	accepted?: boolean;
};
export type Status = "connecting" | "open" | "closed";

/** A request's failure when the socket it was sent on closed, including on a relaying host. */
export const DISCONNECTED = "Disconnected from the host";

/** Silence while a request or watch waits before asking the host for any answer, then before calling it stalled. */
const QUIET = 5000;

/** One WebSocket to a host gateway, reconnecting with backoff until closed. */
export class GatewayClient {
	#socket?: WebSocket;
	#next = 1;
	#pending = new Map<number, Pending>();
	#listeners = new Set<() => void>();
	#terminals = new Map<string, (frame: TerminalFrame) => void>();
	#retry = 250;
	#timer?: ReturnType<typeof setTimeout>;
	#closed = false;
	#metadata = new Map<string, Metadata>();
	#heard = 0;
	#asked?: number;
	#watchdog?: ReturnType<typeof setInterval>;
	status: Status = "connecting";
	/**
	 * The socket is open but the host stopped answering, as while its process is suspended: TCP
	 * keeps the connection, so only silence while a request or watch waits reveals it. Any frame
	 * ends it.
	 */
	stalled = false;
	channels: Listing[] = [];
	projects: Project[] = [];
	people: People = {};
	/** Everyone here by project ID, while the host is connected. */
	presence: Record<string, Presence[]> = {};
	settingsVersion = 0;
	/** Called after every connect so watches can be re-established. */
	onOpen?: () => void;
	/** The mounted channel layout owns tab names and acknowledges changes after persisting them. */
	onRename?: (request: TabRename) => WindowState | Promise<WindowState>;

	constructor(readonly url: string, private readonly token?: string) {
		this.#connect();
	}

	/** Retry now instead of waiting out the backoff, e.g. when a phone wakes the page. */
	wake() {
		if (this.#closed || this.status !== "closed") return;
		clearTimeout(this.#timer);
		this.#retry = 250;
		this.#connect();
	}

	#connect() {
		if (this.#closed) return;
		this.#timer = undefined;
		const socket = new WebSocket(
			this.url,
			this.token ? ["ace", `ace-token.${this.token}`] : undefined,
		);
		this.#socket = socket;
		socket.addEventListener("open", () => {
			this.#retry = 250;
			this.#heard = Date.now();
			this.#watchdog = setInterval(() => this.#check(), 1000);
			this.#set("open");
			this.request<Listing[]>({ op: "channels" }).then((channels) => {
				this.channels = this.#listings(channels);
				this.#emit();
			}, () => {});
			this.onOpen?.();
		});
		socket.addEventListener(
			"message",
			(message) => this.#receive(JSON.parse(String(message.data)) as HostFrame, socket),
		);
		socket.addEventListener("close", () => {
			const ended = [...this.#pending.values()];
			this.#pending.clear();
			this.#metadata.clear();
			clearInterval(this.#watchdog);
			this.#asked = undefined;
			this.stalled = false;
			this.presence = {};
			// Listings outlive the socket so open channels stay mounted until the next connect replaces them.
			this.#set("closed");
			const error = DISCONNECTED;
			for (const pending of ended) {
				if (pending.accepted) pending.watch?.closed?.(error);
				else pending.reject(new Error(error));
			}
			if (this.#closed) return;
			this.#timer = setTimeout(() => this.#connect(), this.#retry);
			this.#retry = Math.min(this.#retry * 2, 5000);
		});
	}

	#receive(frame: HostFrame, socket: WebSocket) {
		this.#heard = Date.now();
		this.#asked = undefined;
		if (this.stalled) {
			this.stalled = false;
			this.#emit();
		}
		if ("rename" in frame) return void this.#rename(frame.rename, socket);
		if ("projects" in frame) {
			this.projects = frame.projects;
			return this.#emit();
		}
		if ("people" in frame) {
			this.people = frame.people;
			return this.#emit();
		}
		if ("presence" in frame) {
			this.presence = frame.presence;
			return this.#emit();
		}
		if ("settings" in frame) {
			this.settingsVersion++;
			return this.#emit();
		}
		if ("channels" in frame) {
			this.channels = this.#listings(frame.channels);
			return this.#emit();
		}
		if ("terminal" in frame) return this.#terminals.get(frame.terminal)?.(frame);
		const pending = this.#pending.get(frame.id);
		if (!pending) return;
		if ("event" in frame) return pending.watch?.event(frame.event);
		if ("waiting" in frame) return pending.waiting?.(frame.waiting);
		// A watch keeps its entry so later events still reach it, until a failure ends it.
		if (pending.watch && frame.ok) {
			pending.accepted = true;
			return pending.resolve(frame.value);
		}
		this.#pending.delete(frame.id);
		if (frame.ok) return pending.resolve(frame.value);
		if (pending.accepted) return pending.watch?.closed?.(frame.error);
		pending.reject(new Error(frame.error));
	}

	#check() {
		if (this.status !== "open" || this.stalled) return;
		const now = Date.now();
		if (now - this.#heard < QUIET) return;
		if (this.#asked === undefined) {
			// An idle socket is quiet by design. An open watch counts as waiting: a relayed channel's
			// watch is often all that crosses to a frozen peer host while its chat is open.
			if (!this.#pending.size) return;
			this.#asked = now;
			this.request({ op: "hello" }).catch(() => {});
		} else if (now - this.#asked >= QUIET) {
			this.stalled = true;
			this.#emit();
		}
	}

	async #rename(request: TabRename, socket: WebSocket) {
		if (socket !== this.#socket || socket.readyState !== WebSocket.OPEN) return;
		let result: Extract<HostRequest, { op: "tab-result" }>["result"];
		try {
			if (request.expires <= Date.now()) throw new Error("Tab rename expired");
			if (!this.onRename) throw new Error("No channel is open in this window");
			result = { ok: true, value: await this.onRename(request) };
		} catch (error) {
			result = { ok: false, error: (error as Error).message };
		}
		// A reply belongs to the connection that received the command, never its replacement.
		if (socket !== this.#socket || socket.readyState !== WebSocket.OPEN) return;
		this.request({ op: "tab-result", call: request.call, result }).catch(() => {});
	}

	/** A hosted channel can advance while its workspace's catalog is offline. */
	#listings(channels: Listing[]): Listing[] {
		return channels.map((channel) => {
			const metadata = this.#metadata.get(channel.id);
			if (!metadata) return channel;
			if ((channel.revision || 0) >= metadata.revision) {
				this.#metadata.delete(channel.id);
				return channel;
			}
			return { ...channel, ...metadata };
		});
	}

	#update(channel: string, metadata: Metadata) {
		const previous = this.#metadata.get(channel);
		if (previous && previous.revision >= metadata.revision) return;
		this.#metadata.set(channel, metadata);
		this.channels = this.channels.map((listing) =>
			listing.id === channel && (listing.revision || 0) < metadata.revision
				? { ...listing, ...metadata }
				: listing
		);
		this.#emit();
	}

	#set(status: Status) {
		this.status = status;
		this.#emit();
	}

	#emit() {
		for (const listener of this.#listeners) listener();
	}

	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	request<T = unknown>(
		request: HostRequest,
		watch?: Watch,
		trace?: string,
	): Promise<T> {
		return this.#request<T>(request, watch ? { watch } : {}, trace);
	}

	/** Move a channel, hearing what the move waits on, such as keychain access, before it answers. */
	move(channel: string, target: string, waiting: (text: string | null) => void): Promise<void> {
		return this.#request({ op: "move", channel, target }, { waiting });
	}

	#request<T>(
		request: HostRequest,
		observe: Pick<Pending, "watch" | "waiting">,
		trace?: string,
	): Promise<T> {
		if (this.status !== "open") return Promise.reject(new Error("Not connected to the host"));
		const id = this.#next++;
		const promise = new Promise<T>((resolve, reject) =>
			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, ...observe })
		);
		this.#socket?.send(JSON.stringify({ id, ...(trace ? { trace } : {}), ...request }));
		return promise;
	}

	channel<T = unknown>(
		channel: string,
		request: Request,
		watch?: Watch,
		trace?: string,
	): Promise<T> {
		const observe = watch && {
			closed: (error: string) => watch.closed?.(error),
			event: (event: Event) => {
				if (event.kind === "metadata") {
					const { name, summary, revision } = event;
					this.#update(channel, { name, summary, revision });
				}
				watch.event(event);
			},
		};
		return this.request<T>({ op: "channel", channel, request }, observe, trace).then((value) => {
			if (request.op === "rename") this.#update(channel, value as Metadata);
			return value;
		});
	}

	/** Receive a terminal's output and exit; returns the unsubscribe. */
	terminal(id: string, listener: (frame: TerminalFrame) => void): () => void {
		this.#terminals.set(id, listener);
		return () => this.#terminals.delete(id);
	}

	close() {
		this.#closed = true;
		this.#socket?.close();
	}
}
