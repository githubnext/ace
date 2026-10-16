import { isInactive, type Listing, type People, type Presence } from "@ace/host/protocol";

import { present } from "./presence";

/** A teammate by GitHub login where known; `here` is unset while they have nothing open. */
export type Teammate = {
	login: string;
	here?: "here" | "away";
	active: Listing[];
	finished: Listing[];
	failed: Listing[];
};

const ACTIVE = 3;

/**
 * Deterministic team pulse from listings and the lobby: who is here, their active channels, and
 * runs that ended in their channels after `since`. Teammates with none of these are left out.
 */
export function pulse(
	channels: Listing[],
	presence: Presence[] | undefined,
	people: People,
	user: string,
	since: number,
	now: number,
): Teammate[] {
	const team = new Map<string, Teammate>();
	const get = (login: string) => {
		let value = team.get(login);
		if (!value) {
			value = { login, active: [], finished: [], failed: [] };
			team.set(login, value);
		}
		return value;
	};
	for (const member of present(presence, people[user])) {
		get(member.id).here = member.away ? "away" : "here";
	}
	const latest = (channel: Listing) => channel.active || channel.created;
	for (const channel of [...channels].sort((a, b) => latest(b) - latest(a))) {
		if (channel.owner === user) continue;
		const ended = channel.ran && channel.ran.at > since ? channel.ran.outcome : undefined;
		const live = channel.state !== "archived" && !isInactive(channel, now);
		if (!live && ended !== "done" && ended !== "failed") continue;
		const teammate = get(people[channel.owner] || channel.owner);
		if (live && teammate.active.length < ACTIVE) teammate.active.push(channel);
		if (ended === "done") teammate.finished.push(channel);
		if (ended === "failed") teammate.failed.push(channel);
	}
	const order = { here: 0, away: 1 };
	return [...team.values()].sort((a, b) =>
		(a.here ? order[a.here] : 2) - (b.here ? order[b.here] : 2) || a.login.localeCompare(b.login)
	);
}
