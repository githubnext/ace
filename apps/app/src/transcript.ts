import { useEffect, useState } from "react";

import type { Image, QueuedMessage, Reactions, TextFile } from "@ace/channel/protocol";
import { DISCONNECTED } from "@ace/host/gateway-client";
import { CHANNEL_CLOSED, type ChannelInfo, type Event } from "@ace/host/protocol";

import { host, onOpen } from "./host";

export type Tool = {
	call: string;
	name: string;
	args: unknown;
	result?: {
		error: boolean;
		text: string;
		images?: Image[];
		interrupted?: boolean;
		handoff?: boolean;
	};
	/** The running call's live output tail, until its result replaces it. */
	progress?: { text: string; truncated?: boolean };
};

export type Item =
	| {
		kind: "message";
		key: string;
		entry: number;
		at: number;
		author: string;
		text: string;
		images?: Image[];
		files?: TextFile[];
		invoked: boolean;
		deleted?: boolean;
	}
	| {
		kind: "reply";
		key: string;
		/** Absent for a reply that only called tools, which takes no reactions. */
		entry?: number;
		at: number;
		model: string;
		text: string;
		tools: Tool[];
		error?: string;
		stopped?: boolean;
		/** Queued messages withdrawn when the run was stopped. */
		withdrawn?: QueuedMessage[];
	};

export type Transcript = {
	items: Item[];
	queue: QueuedMessage[];
	/** Every message withdrawn from the queue while watched, for its author's composer. */
	returned: QueuedMessage[];
	/** Withdrawn messages waiting for their run's end, so the notice follows its "Stopped." */
	withdrawn: QueuedMessage[];
	/** Each tool call's group caption, by call ID. */
	captions: Record<string, string>;
	/** Each tool call's recap of the work it was part of, by call ID. */
	recaps: Record<string, string>;
	reactions: Reactions;
	/** Text streamed for the reply being generated. */
	draft: string;
	busy: boolean;
	live: boolean;
	/** Whether teammates may invoke agents, from the newest metadata event that reported it. */
	shared?: boolean;
	desktop?: boolean;
};

const EMPTY: Transcript = {
	items: [],
	queue: [],
	returned: [],
	withdrawn: [],
	captions: {},
	recaps: {},
	reactions: {},
	draft: "",
	busy: false,
	live: false,
};

/** Folds channel events into timeline items: tool calls attach to the reply that made them. */
export function apply(state: Transcript, event: Event): Transcript {
	switch (event.kind) {
		case "queue": {
			if (!event.withdrawn) return { ...state, queue: event.messages };
			const returned = [...state.returned, ...event.withdrawn];
			if (state.busy) {
				const withdrawn = [...state.withdrawn, ...event.withdrawn];
				return { ...state, queue: event.messages, returned, withdrawn };
			}
			const items = withdraw(state.items, event.withdrawn);
			return { ...state, queue: event.messages, returned, items };
		}
		case "message":
			return {
				...state,
				items: [...state.items, { kind: "message", key: `e${event.entry}`, ...pick(event) }],
			};
		case "deleted":
			return {
				...state,
				items: state.items.map((item) =>
					item.kind === "message" && item.entry === event.entry
						? { ...item, text: "", images: undefined, deleted: true }
						: item
				),
			};
		case "reactions":
			return { ...state, reactions: event.reactions };
		case "reply": {
			const item: Item = {
				kind: "reply",
				key: `e${event.entry}`,
				entry: event.entry,
				at: event.at,
				model: event.model,
				text: event.text,
				tools: [],
				...(event.error ? { error: event.error } : {}),
				...(event.stopped ? { stopped: true } : {}),
			};
			return { ...state, draft: "", items: [...state.items, item] };
		}
		case "tool": {
			const tool: Tool = { call: event.call, name: event.name, args: event.args };
			const last = state.items.at(-1);
			if (last?.kind === "reply" && !last.text) {
				return {
					...state,
					items: [...state.items.slice(0, -1), { ...last, tools: [...last.tools, tool] }],
				};
			}
			if (last?.kind === "reply" && last.at === event.at) {
				return {
					...state,
					items: [...state.items.slice(0, -1), { ...last, tools: [...last.tools, tool] }],
				};
			}
			const item: Item = {
				kind: "reply",
				key: `t${event.call}`,
				at: event.at,
				model: event.model,
				text: "",
				tools: [tool],
			};
			return { ...state, draft: "", items: [...state.items, item] };
		}
		case "progress": {
			const progress = { text: event.text, ...(event.truncated ? { truncated: true } : {}) };
			return {
				...state,
				items: state.items.map((item) =>
					item.kind === "reply" && item.tools.some((tool) => tool.call === event.call)
						? {
							...item,
							tools: item.tools.map((tool) =>
								tool.call === event.call && !tool.result ? { ...tool, progress } : tool
							),
						}
						: item
				),
			};
		}
		case "result":
			return {
				...state,
				items: state.items.map((item) =>
					item.kind === "reply" && item.tools.some((tool) => tool.call === event.call)
						? {
							...item,
							...(event.stopped ? { stopped: true } : {}),
							tools: item.tools.map((tool) =>
								tool.call === event.call
									? {
										call: tool.call,
										name: tool.name,
										args: tool.args,
										result: {
											error: event.error,
											text: event.text,
											...(event.images ? { images: event.images } : {}),
											...(event.interrupted ? { interrupted: true } : {}),
											...(event.handoff ? { handoff: true } : {}),
										},
									}
									: tool
							),
						}
						: item
				),
			};
		case "caption": {
			const captions = { ...state.captions };
			for (const call of event.calls) captions[call] = event.text;
			return { ...state, captions };
		}
		case "recap": {
			const recaps = { ...state.recaps };
			for (const call of event.calls) recaps[call] = event.text;
			return { ...state, recaps };
		}
		case "delta":
			return { ...state, draft: state.draft + event.text };
		case "run": {
			const busy = event.state === "start";
			if (busy || !state.withdrawn.length) return { ...state, busy, draft: "" };
			const items = withdraw(state.items, state.withdrawn);
			return { ...state, busy, draft: "", items, withdrawn: [] };
		}
		case "live":
			return { ...state, live: true };
		case "metadata": {
			const shared = event.shared ?? state.shared;
			const desktop = event.desktop ?? state.desktop;
			return shared === state.shared && desktop === state.desktop
				? state
				: { ...state, shared, desktop };
		}
	}
}

/** The notice joins the stopped reply; a run stopped before replying gets a reply of its own. */
function withdraw(items: Item[], messages: QueuedMessage[]): Item[] {
	const last = items.at(-1);
	if (last?.kind === "reply") {
		const withdrawn = [...(last.withdrawn || []), ...messages];
		return [...items.slice(0, -1), { ...last, withdrawn }];
	}
	const item: Item = {
		kind: "reply",
		key: `w${messages[0]!.submission}`,
		at: Date.now(),
		model: "",
		text: "",
		tools: [],
		withdrawn: messages,
	};
	return [...items, item];
}

function pick(event: Extract<Event, { kind: "message" }>) {
	const { entry, at, author, text, images, files, invoked, deleted } = event;
	return {
		entry,
		at,
		author,
		text,
		...(images ? { images } : {}),
		...(files ? { files } : {}),
		invoked,
		...(deleted ? { deleted } : {}),
	};
}

/** Automatic re-watches allowed before a watch stays open for `STABLE` ms. */
const RECOVERIES = 3;
const STABLE = 60_000;

/**
 * Watches one chat of a channel. Owns the watch: re-watches after the host reconnects, the watch
 * ends, such as when the channel's worker restarts, or a relaying host's connection drops before
 * the watch starts, and releases it on unmount. A failed watch retries once when its channel's
 * host comes back from `offline`.
 */
export function useTranscript(
	channel: string | undefined,
	chat: number | undefined,
	offline: boolean,
	placement: string,
) {
	const [state, setState] = useState<Transcript>(EMPTY);
	const [info, setInfo] = useState<ChannelInfo>();
	const [error, setError] = useState<string>();
	/** The channel's worker ended the watch and a re-watch is waiting for it to come back. */
	const [restarting, setRestarting] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [wasOffline, setWasOffline] = useState(offline);
	if (offline !== wasOffline) {
		setWasOffline(offline);
		if (!offline && error) setAttempt((value) => value + 1);
	}
	// A move ends watches at the old placement, and rewatching fails until it finishes; the
	// listing's placement, which names a move under way, changing when the move ends is the signal
	// to watch again, for every client, even when a failed move leaves the channel where it was.
	const [placed, setPlaced] = useState(placement);
	if (placement !== placed) {
		setPlaced(placement);
		setAttempt((value) => value + 1);
	}
	useEffect(() => {
		if (!channel) return;
		let active = true;
		let generation = 0;
		let recoveries = 0;
		let started = 0;
		setState(EMPTY);
		setInfo(undefined);
		const start = (restart = false) => {
			const version = ++generation;
			started = Date.now();
			setError(undefined);
			setRestarting(restart);
			const current = () => active && version === generation;
			const recover = (reason: string) => {
				if (Date.now() - started > STABLE) recoveries = 0;
				if (recoveries++ >= RECOVERIES) return false;
				start(reason === CHANNEL_CLOSED);
				return true;
			};
			// A re-watch replays the whole chat; the shown transcript stays until the replay is
			// complete so the timeline, and what is expanded in it, stays mounted.
			let replay: Transcript | undefined = EMPTY;
			const refresh = () =>
				host.channel<ChannelInfo>(channel, { op: "info" }).then((value) => {
					if (current()) setInfo(value);
				}, () => {});
			void refresh();
			host.channel(channel, {
				op: "watch",
				queue: true,
				captions: true,
				progress: true,
				actions: true,
				...(chat === undefined ? {} : { chat }),
			}, {
				event(event) {
					if (!current()) return;
					if (!replay) setState((state) => apply(state, event));
					else if (event.kind !== "live") replay = apply(replay, event);
					else {
						setState(apply(replay, event));
						setRestarting(false);
						replay = undefined;
					}
					if (event.kind === "run") void refresh();
				},
				// A released watch belongs to an old generation; a reconnecting host restarts every watch.
				closed(reason) {
					if (!current() || host.status !== "open" || recover(reason)) return;
					generation++;
					setState(EMPTY);
					setInfo(undefined);
					setRestarting(false);
					setError(reason);
				},
			}).catch((error: Error) => {
				if (!current()) return;
				// Only this app's own socket closing is handled by `onOpen`; a relay's drop leaves it open.
				if (host.status === "open" && error.message === DISCONNECTED && recover(error.message)) {
					return;
				}
				setState(EMPTY);
				setInfo(undefined);
				setRestarting(false);
				setError(error.message);
			});
		};
		start();
		const off = onOpen(() => {
			recoveries = 0;
			start();
		});
		return () => {
			active = false;
			off();
			host.request({ op: "release", channel }).catch(() => {});
		};
	}, [channel, chat, attempt]);
	// Hosts that predate sharing in metadata events report it only through `info`, which is not
	// read again after a share; `sharedLive` says whether changes will arrive.
	const shared = state.shared ?? info?.shared;
	const sharedLive = state.shared !== undefined;
	return {
		...state,
		shared,
		sharedLive,
		desktop: state.desktop ?? info?.desktop,
		desktopLive: state.desktop !== undefined,
		info,
		error,
		restarting,
		retry: () => setAttempt((value) => value + 1),
	};
}
