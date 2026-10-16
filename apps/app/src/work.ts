import type { GithubItem } from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";

import type { Outcome } from "./attention";

/** A pull request or issue for the viewer, with the channel already on it. */
export type Work = { item: GithubItem; reason: string; channel?: Listing };

export type NeedsYou =
	| { kind: "channel"; channel: Listing; outcome: Exclude<Outcome, "done"> }
	| { kind: "review"; work: Work };

const ROWS = 10;

/**
 * A lane's branch is `<channel prefix>/<lane>`, and prefixes are unique on a host, so a pull
 * request's head names the channel that pushed it. The viewer's own channel wins a collision
 * between hosts.
 */
export function byBranch(channels: Listing[], user: string): Map<string, Listing> {
	const found = new Map<string, Listing>();
	for (const channel of channels) {
		if (channel.state === "archived") continue;
		const prefix = channel.prefix || channel.name;
		if (found.get(prefix)?.owner === user) continue;
		found.set(prefix, channel);
	}
	return found;
}

const onBranch = (item: GithubItem, channels: Map<string, Listing>) =>
	item.head ? channels.get(item.head.split("/")[0]!) : undefined;

/**
 * Old Ace's ranking: items with a channel first, then the viewer's drafts, their other pull
 * requests, and issues assigned to them, newest first. A fork's pull request has no branch here
 * to continue, so it shows only when a channel is already on it.
 */
export function pickBackUp(
	authored: GithubItem[],
	assigned: GithubItem[],
	channels: Map<string, Listing>,
): Work[] {
	const ranked: { rank: number; work: Work }[] = [];
	for (const item of authored) {
		const channel = onBranch(item, channels);
		if (item.fork && !channel) continue;
		const draft = item.state === "draft";
		ranked.push({
			rank: channel ? 10 : draft ? 20 : 30,
			work: { item, channel, reason: draft ? "Your draft" : "Your pull request" },
		});
	}
	for (const item of assigned) {
		ranked.push({ rank: 50, work: { item, reason: "Assigned to you" } });
	}
	return ranked.sort((a, b) =>
		a.rank - b.rank || b.work.item.updated.localeCompare(a.work.item.updated)
	).slice(0, ROWS).map(({ work }) => work);
}

/** The viewer's failed runs and unanswered questions, newest first, then requested reviews. */
export function needsYou(
	channels: Listing[],
	attention: Map<string, Outcome>,
	reviews: GithubItem[],
	branches: Map<string, Listing>,
): NeedsYou[] {
	const waiting: NeedsYou[] = channels.flatMap((channel) => {
		const outcome = attention.get(channel.id);
		if (!outcome || outcome === "done" || channel.state === "archived") return [];
		return [{ kind: "channel" as const, channel, outcome }];
	}).sort((a, b) => b.channel.ran!.at - a.channel.ran!.at);
	return [
		...waiting,
		...reviews.map((item): NeedsYou => ({
			kind: "review",
			work: { item, channel: onBranch(item, branches), reason: "Review requested" },
		})),
	];
}
