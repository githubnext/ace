import { useSyncExternalStore } from "react";

import type { Changes, GithubPull } from "@ace/channel/protocol";
import type { ChannelInfo } from "@ace/host/protocol";

import type { Item } from "./transcript";

/** What an open channel's views know, shared with its details sidebar outside their tree. */
export type Details = {
	info?: ChannelInfo;
	changes?: Changes;
	/** The chat branch's newest pull request; `null` once read and none exists. */
	pull?: GithubPull | null;
	/** Whether the chat's agent was asked to open a pull request and hasn't finished. */
	creating?: boolean;
	items?: Item[];
	/** Whether teammates may invoke agents, as the chat's watch reports it. */
	shared?: boolean;
	/** Whether the watch follows sharing changes; older hosts report only a snapshot. */
	sharedLive?: boolean;
	desktop?: boolean;
	desktopLive?: boolean;
	/** Shows the chat's Diff tab, opening one when none is open. */
	diff?: () => void;
};

const EMPTY: Details = {};
const values = new Map<string, Details>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => void listeners.delete(listener);
}

/**
 * Undefined fields keep their last known value, so a channel opened again shows what it showed
 * before and its fresh reads replace that in place instead of the sidebar emptying and refilling.
 */
export function publish(channel: string, patch: Details) {
	const next = { ...values.get(channel) };
	for (const [key, value] of Object.entries(patch)) {
		if (value !== undefined) Object.assign(next, { [key]: value });
	}
	values.set(channel, next);
	for (const listener of listeners) listener();
}

/** Drops the Diff opener, which only works while the channel's tabs are mounted. */
export function forget(channel: string) {
	const { diff: _, ...rest } = values.get(channel) || {};
	values.set(channel, rest);
	for (const listener of listeners) listener();
}

export function useDetails(channel: string): Details {
	return useSyncExternalStore(subscribe, () => values.get(channel) || EMPTY);
}
