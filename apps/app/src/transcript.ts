import { useEffect, useState } from "react";

import type { Image, QueuedMessage } from "@ace/channel/protocol";
import type { ChannelInfo, Event } from "@ace/host/protocol";

import { host, onOpen } from "./host";

export type Tool = {
	call: string;
	name: string;
	args: unknown;
	result?: { error: boolean; text: string; images?: Image[] };
};

export type Item =
	| {
		kind: "message";
		key: string;
		at: number;
		author: string;
		text: string;
		images?: Image[];
		invoked: boolean;
	}
	| {
		kind: "reply";
		key: string;
		at: number;
		model: string;
		text: string;
		tools: Tool[];
		error?: string;
		stopped?: boolean;
	};

export type Transcript = {
	items: Item[];
	queue: QueuedMessage[];
	/** Each tool call's group caption, by call ID. */
	captions: Record<string, string>;
	/** Each tool call's recap of the work it was part of, by call ID. */
	recaps: Record<string, string>;
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
	captions: {},
	recaps: {},
	draft: "",
	busy: false,
	live: false,
};

/** Folds channel events into timeline items: tool calls attach to the reply that made them. */
export function apply(state: Transcript, event: Event): Transcript {
	switch (event.kind) {
		case "queue":
			return { ...state, queue: event.messages };
		case "message":
			return {
				...state,
				items: [...state.items, { kind: "message", key: `e${event.entry}`, ...pick(event) }],
			};
		case "reply": {
			const item: Item = {
				kind: "reply",
				key: `e${event.entry}`,
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
										...tool,
										result: {
											error: event.error,
											text: event.text,
											...(event.images ? { images: event.images } : {}),
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
		case "run":
			return { ...state, busy: event.state === "start", draft: "" };
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

function pick(event: Extract<Event, { kind: "message" }>) {
	const { at, author, text, images, invoked } = event;
	return { at, author, text, ...(images ? { images } : {}), invoked };
}

/** Automatic re-watches allowed before a watch stays open for `STABLE` ms. */
const RECOVERIES = 3;
const STABLE = 60_000;

/**
 * Watches one chat of a channel. Owns the watch: re-watches after the host reconnects or the
 * watch ends, such as when the channel's worker restarts, and releases it on unmount. A failed
 * watch retries once when its channel's host comes back from `offline`.
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
	const [attempt, setAttempt] = useState(0);
	const [wasOffline, setWasOffline] = useState(offline);
	if (offline !== wasOffline) {
		setWasOffline(offline);
		if (!offline && error) setAttempt((value) => value + 1);
	}
	// A move ends watches at the old placement, and rewatching fails until it finishes; the
	// listing's new placement is the signal to watch again, for every client.
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
		const start = () => {
			const version = ++generation;
			started = Date.now();
			setState(EMPTY);
			setInfo(undefined);
			setError(undefined);
			const current = () => active && version === generation;
			const refresh = () =>
				host.channel<ChannelInfo>(channel, { op: "info" }).then((value) => {
					if (current()) setInfo(value);
				}, () => {});
			void refresh();
			host.channel(channel, {
				op: "watch",
				queue: true,
				captions: true,
				...(chat === undefined ? {} : { chat }),
			}, {
				event(event) {
					if (!current()) return;
					setState((state) => apply(state, event));
					if (event.kind === "run") void refresh();
				},
				// A released watch belongs to an old generation; a reconnecting host restarts every watch.
				closed(reason) {
					if (!current() || host.status !== "open") return;
					if (Date.now() - started > STABLE) recoveries = 0;
					if (recoveries++ < RECOVERIES) return start();
					generation++;
					setState(EMPTY);
					setInfo(undefined);
					setError(reason);
				},
			}).catch((error: Error) => {
				if (current()) setError(error.message);
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
		retry: () => setAttempt((value) => value + 1),
	};
}
