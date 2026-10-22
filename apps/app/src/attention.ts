import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { useLocalStorage } from "@ace/ui";
import type { RunEnd } from "@ace/channel/protocol";
import type { Listing, People } from "@ace/host/protocol";

import { desktop } from "./desktop";
import { isFocused, subscribe } from "./focus";
import { host } from "./host";

/**
 * Run ends and messages this person has seen or been told about, by channel, and how many mentions
 * of them each channel had when they last saw it (`heard`) or were told (`called`). Anything before
 * `since` predates this browser profile's first visit, so history never lights up. Profiles from
 * before mentions have no `heard`, and from before mention notices no `called`.
 */
type State = {
	since: number;
	seen: Record<string, number>;
	told: Record<string, number>;
	heard?: Record<string, number>;
	called?: Record<string, number>;
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

// Listings outlive the socket and refresh just after each connect, behind other updates, so mentions
// found that soon after one arrived while this person was away.
const CATCH_UP = 10_000;
let opened = host.status === "open" ? Date.now() : 0;
let caught = false;
host.subscribe(() => {
	if (host.status !== "open") opened = 0;
	if (host.status !== "open" || opened) return;
	opened = Date.now();
	caught = false;
});

const seenAt = (channel: Listing, state: State) =>
	Math.max(state.since, state.seen[channel.id] || 0);

/** A stopped run was a participant's own doing, so it needs no attention. */
function pending(channel: Listing, user: string, state: State): Outcome | undefined {
	const { ran } = channel;
	if (!ran || ran.author !== user || ran.outcome === "stopped") return;
	if (ran.at <= seenAt(channel, state)) return;
	return ran.outcome;
}

/** A run a teammate asked for in this person's channel, which ran with their machine and key. */
function isTeammateRun(channel: Listing, user: string, state: State): boolean {
	const { ran } = channel;
	if (!ran || channel.owner !== user || ran.author === user) return false;
	if (ran.outcome !== "done" && ran.outcome !== "failed") return false;
	return ran.at > seenAt(channel, state);
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

const times = (count: number) => count === 1 ? "Mentioned you" : `Mentioned you ${count} times`;

/** One notice for every mention that arrived while this person was away, so a reconnect never floods. */
function missed(found: { channel: Listing; count: number }[]): [string, string] {
	const [{ channel, count }] = found;
	if (found.length === 1) return [channel.name, `${times(count)} while you were away`];
	const list = found.map((value) => `${value.count} in ${value.channel.name}`).join(", ");
	return ["Mentions while you were away", list];
}

/**
 * Runs this person invoked that ended, or that wait on a question, while they were not watching the
 * channel, teammates' runs that ended in their channels, and new @mentions of `names` (lowercased
 * GitHub logins). Each pulses the window's glow or sends one desktop notification, then marks its
 * row until they open it; mentions that arrived while Ace was closed or disconnected notify once
 * together. Others' messages mark the row too, without a notification.
 */
export function useAttention(
	channels: Listing[],
	user: string,
	names: string[],
	open: string | undefined,
	people: People,
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
		const called: Record<string, number> = {};
		const mentions: { channel: Listing; count: number }[] = [];
		// Until the person's GitHub login loads, every count reads zero and would re-tell old mentions.
		const named = names.length > 0;
		const away = named && !caught && Date.now() - opened < CATCH_UP;
		for (const channel of channels) {
			const { id, ran, said } = channel;
			const looking = watching && id === open;
			// Mentions are counts, not times, so each channel keeps the count it was last seen at.
			const count = looking ? mentioned(channel, names) : baseline(channel, names, state);
			if (state.heard?.[id] !== count) heard[id] = count;
			const total = mentioned(channel, names);
			const before = state.called?.[id] ?? baseline(channel, names, state);
			if (named && total !== before) called[id] = total;
			if (named && total > before && !looking) mentions.push({ channel, count: total - before });
			if (looking) {
				const last = Math.max(ran?.at || 0, said?.at || 0);
				if ((state.seen[id] || 0) < last) seen[id] = last;
				continue;
			}
			if (!ran) continue;
			const outcome = pending(channel, user, state);
			if (!outcome && !isTeammateRun(channel, user, state)) continue;
			if (ran.at <= (state.told[id] || 0)) continue;
			told[id] = ran.at;
			if (watching) setPulse("on");
			else if (outcome) desktop?.notify(channel.name, NOTICES[outcome]).catch(() => {});
			else {
				const who = people[ran.author] || ran.author.split("@")[0];
				const failed = ran.outcome === "failed" ? ", and the run failed" : "";
				desktop?.notify(channel.name, `${who} used your agent${failed}`).catch(() => {});
			}
		}
		if (away && mentions.length) {
			caught = true;
			const [title, body] = missed(mentions);
			desktop?.notify(title, body).catch(() => {});
		} else if (mentions.length && watching) setPulse("on");
		else {
			for (const { channel, count } of mentions) {
				desktop?.notify(channel.name, times(count)).catch(() => {});
			}
		}
		const changes = [seen, told, heard, called].some((value) => Object.keys(value).length);
		if (!changes) return;
		setState((value) =>
			value && {
				...value,
				seen: { ...value.seen, ...seen },
				told: { ...value.told, ...told },
				heard: { ...value.heard, ...heard },
				called: { ...value.called, ...called },
			}
		);
	}, [channels, user, names, state, setState, watching, open, people]);

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

	/** When this person last saw a channel; undefined before this profile's first visit. */
	const seen = (channel: Listing) => state ? seenAt(channel, state) : undefined;

	return { attention, pulse, seen };
}
