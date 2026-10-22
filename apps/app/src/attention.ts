import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { useLocalStorage } from "@ace/ui";
import type { RunEnd } from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";

import { desktop } from "./desktop";
import { isFocused, subscribe } from "./focus";
import { host } from "./host";

/**
 * Run ends and messages this person has seen or been told about, by channel, and how many mentions
 * of them each channel had when they last saw it. Anything before `since` predates this browser
 * profile's first visit, so history never lights up. Profiles from before mentions have no `heard`.
 */
type State = {
	since: number;
	seen: Record<string, number>;
	told: Record<string, number>;
	heard?: Record<string, number>;
};

export type Outcome = Exclude<RunEnd["outcome"], "stopped">;

/** A run this person invoked, or `message` for anything anyone else wrote since they last looked. */
export type Mark = Outcome | "message";

/** What a channel holds for this person since they last saw it. */
export type Attention = { mark?: Mark; mentions: number };

const NOTICES: Record<Outcome, string> = {
	done: "Agent finished",
	failed: "Agent run failed",
	question: "Agent is waiting for your answer",
};

/** The pulse holds its glow this long, then keeps these props until it has faded out. */
export const glow = { hold: 1800, props: { glowOpacity: 0.6, glowFadeIn: 0.8, glowFadeOut: 1.3 } };

const seenAt = (channel: Listing, state: State) =>
	Math.max(state.since, state.seen[channel.id] || 0);

/** A stopped run was a participant's own doing, so it needs no attention. */
function pending(channel: Listing, user: string, state: State): Outcome | undefined {
	const { ran } = channel;
	if (!ran || ran.author !== user || ran.outcome === "stopped") return;
	if (ran.at <= seenAt(channel, state)) return;
	return ran.outcome;
}

function mark(channel: Listing, user: string, state: State): Mark | undefined {
	const outcome = pending(channel, user, state);
	if (outcome) return outcome;
	const { said } = channel;
	if (said && said.author !== user && said.at > seenAt(channel, state)) return "message";
}

/** Every mention of any of this person's names the channel's host has counted. */
function mentioned(channel: Listing, names: string[]): number {
	return names.reduce((total, name) => total + (channel.mentions?.[name] || 0), 0);
}

/** A channel first met after `since` started after this profile did, so all its mentions are new. */
function baseline(channel: Listing, names: string[], state: State): number {
	return state.heard?.[channel.id]
		?? (channel.created > state.since ? 0 : mentioned(channel, names));
}

/**
 * Runs this person invoked that ended, or that wait on a question, while they were not watching the
 * channel. Each pulses the window's glow or sends one desktop notification, then marks its row
 * until they open it. Others' messages and @mentions of `names` (lowercased GitHub logins) mark the
 * row too, without a notification.
 */
export function useAttention(
	channels: Listing[],
	user: string,
	names: string[],
	open: string | undefined,
) {
	const [state, setState] = useLocalStorage<State | null>(
		`ace:attention:${host.url}:${user}`,
		null,
	);
	const watching = useSyncExternalStore(subscribe, isFocused);
	const [pulse, setPulse] = useState<"on" | "fading">();

	useEffect(() => {
		if (user && !state) setState({ since: Date.now(), seen: {}, told: {}, heard: {} });
	}, [user, state, setState]);

	useEffect(() => {
		if (!user || !state) return;
		const seen: Record<string, number> = {};
		const told: Record<string, number> = {};
		const heard: Record<string, number> = {};
		for (const channel of channels) {
			const { id, ran, said } = channel;
			const looking = watching && id === open;
			// Mentions are counts, not times, so each channel keeps the count it was last seen at.
			const count = looking ? mentioned(channel, names) : baseline(channel, names, state);
			if (state.heard?.[id] !== count) heard[id] = count;
			if (looking) {
				const last = Math.max(ran?.at || 0, said?.at || 0);
				if ((state.seen[id] || 0) < last) seen[id] = last;
				continue;
			}
			if (!ran) continue;
			const outcome = pending(channel, user, state);
			if (!outcome || ran.at <= (state.told[id] || 0)) continue;
			told[id] = ran.at;
			if (watching) setPulse("on");
			else {
				desktop?.notify(channel.name, NOTICES[outcome]).catch(() => {});
			}
		}
		if (!Object.keys(seen).length && !Object.keys(told).length && !Object.keys(heard).length) {
			return;
		}
		setState((value) =>
			value && {
				...value,
				seen: { ...value.seen, ...seen },
				told: { ...value.told, ...told },
				heard: { ...value.heard, ...heard },
			}
		);
	}, [channels, user, names, state, setState, watching, open]);

	useEffect(() => {
		if (!pulse) return;
		const timer = setTimeout(
			() => setPulse(pulse === "on" ? "fading" : undefined),
			pulse === "on" ? glow.hold : glow.props.glowFadeOut * 1000,
		);
		return () => clearTimeout(timer);
	}, [pulse]);

	const attention = useMemo(() => {
		const found = new Map<string, Attention>();
		if (!state) return found;
		for (const channel of channels) {
			const value = mark(channel, user, state);
			const mentions = Math.max(0, mentioned(channel, names) - baseline(channel, names, state));
			if (value || mentions) found.set(channel.id, { mark: value, mentions });
		}
		return found;
	}, [channels, user, names, state]);

	return { attention, pulse };
}
