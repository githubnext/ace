import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { useLocalStorage } from "@ace/ui";
import type { RunEnd } from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";

import { desktop } from "./desktop";
import { host } from "./host";

/**
 * Run ends this person has seen or been told about, by channel. Ends before `since` predate this
 * browser profile's first visit, so history never lights up.
 */
type State = { since: number; seen: Record<string, number>; told: Record<string, number> };

export type Outcome = Exclude<RunEnd["outcome"], "stopped">;

/** The pulse holds its glow this long, then keeps these props until it has faded out. */
export const glow = { hold: 1800, props: { glowOpacity: 0.6, glowFadeIn: 0.8, glowFadeOut: 1.3 } };

const EVENTS = ["focus", "blur", "visibilitychange"];

function subscribe(listener: () => void) {
	for (const event of EVENTS) addEventListener(event, listener);
	return () => {
		for (const event of EVENTS) removeEventListener(event, listener);
	};
}

const isWatching = () => document.visibilityState === "visible" && document.hasFocus();

/** A stopped run was a participant's own doing, so it needs no attention. */
function pending(channel: Listing, user: string, state: State): Outcome | undefined {
	const { ran } = channel;
	if (!ran || ran.author !== user || ran.outcome === "stopped") return;
	if (ran.at <= Math.max(state.since, state.seen[channel.id] || 0)) return;
	return ran.outcome;
}

/**
 * Runs this person invoked that ended while they were not watching the channel. Each end pulses
 * the window's glow or sends one desktop notification, then marks its row until they open it.
 */
export function useAttention(channels: Listing[], user: string, open: string | undefined) {
	const [state, setState] = useLocalStorage<State | null>(
		`ace:attention:${host.url}:${user}`,
		null,
	);
	const watching = useSyncExternalStore(subscribe, isWatching);
	const [pulse, setPulse] = useState<"on" | "fading">();

	useEffect(() => {
		if (user && !state) setState({ since: Date.now(), seen: {}, told: {} });
	}, [user, state, setState]);

	useEffect(() => {
		if (!user || !state) return;
		const seen: Record<string, number> = {};
		const told: Record<string, number> = {};
		for (const channel of channels) {
			const { id, ran } = channel;
			if (!ran) continue;
			if (watching && id === open) {
				if ((state.seen[id] || 0) < ran.at) seen[id] = ran.at;
				continue;
			}
			const outcome = pending(channel, user, state);
			if (!outcome || ran.at <= (state.told[id] || 0)) continue;
			told[id] = ran.at;
			if (watching) setPulse("on");
			else {
				desktop?.notify(channel.name, outcome === "failed" ? "Agent run failed" : "Agent finished")
					.catch(() => {});
			}
		}
		if (!Object.keys(seen).length && !Object.keys(told).length) return;
		setState((value) =>
			value && { ...value, seen: { ...value.seen, ...seen }, told: { ...value.told, ...told } }
		);
	}, [channels, user, state, setState, watching, open]);

	useEffect(() => {
		if (!pulse) return;
		const timer = setTimeout(
			() => setPulse(pulse === "on" ? "fading" : undefined),
			pulse === "on" ? glow.hold : glow.props.glowFadeOut * 1000,
		);
		return () => clearTimeout(timer);
	}, [pulse]);

	const attention = useMemo(() => {
		const found = new Map<string, Outcome>();
		if (!state) return found;
		for (const channel of channels) {
			const outcome = pending(channel, user, state);
			if (outcome) found.set(channel.id, outcome);
		}
		return found;
	}, [channels, user, state]);

	return { attention, pulse };
}
