import {
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import type { Changes, GithubPull } from "@ace/channel/protocol";
import type { ChannelInfo, Listing } from "@ace/host/protocol";
import {
	type DetailsChanges,
	type DetailsFact,
	type DetailsLink,
	type DetailsSubagent,
	SessionDetailsView,
	Sidebar,
	useLayoutRight,
} from "@ace/ui";
import { IconCloud } from "@ace/ui/icons";

import { ChannelAccess } from "./channel-access";
import { EFFORTS } from "./composer";
import { Conversation } from "./conversation";
import { forget, publish, useDetails } from "./details";
import { host } from "./host";
import { CHAT, Layout } from "./layout/layout";
import { Diff, GROUPS } from "./panels/diff";
import { Terminal } from "./panels/terminal";
import type { Item } from "./transcript";

// Channels have one chat today; its tabs follow the chat the Chat tab shows.
const chat = 1;

export type ChannelDraft = { channel: string; text: string };

type Props = {
	channel: Listing;
	channels: Listing[];
	user: string;
	remote: boolean;
	draft?: ChannelDraft;
	onDraftLoaded: () => void;
	onSettings?: () => void;
	onOpen: (channel: Listing) => void;
};

const LINK = /https?:\/\/[^\s<>()[\]{}"'`]+/g;
const GITHUB = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)\/?$/;
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
// Open checks change on their own, so a visible pull request is read again this often.
const PULL = 60_000;

/** Links people and agents wrote in the chat, newest mention first; tool output is left out. */
function links(items: Item[], repo?: string): DetailsLink[] {
	const seen = new Map<string, DetailsLink>();
	for (const item of items) {
		for (const match of item.text.matchAll(LINK)) {
			const url = match[0].replace(/[.,;:!?*_]+$/, "");
			if (!URL.canParse(url)) continue;
			seen.delete(url);
			const github = GITHUB.exec(url);
			if (github) {
				const [, path, kind, number] = github;
				const label = `${path === repo ? "" : path}#${number}`;
				seen.set(url, { url, label, kind: kind === "pull" ? "pull" : "issue" });
				continue;
			}
			const { host, pathname, search } = new URL(url);
			seen.set(url, { url, label: `${host}${pathname.replace(/\/$/, "")}${search}`, kind: "web" });
		}
	}
	return [...seen.values()].toReversed();
}

function subagents(items: Item[], busy: boolean): DetailsSubagent[] {
	return items.flatMap((item) =>
		item.kind === "reply"
			? item.tools.filter((tool) => tool.name === "subagent").map((tool) => {
				const args = tool.args as { task?: string; model?: string };
				const state: DetailsSubagent["state"] = tool.result
					? tool.result.error ? "failed" : "done"
					: busy && !item.stopped
					? "running"
					: "stopped";
				const task = args.task?.trim().split("\n")[0] || "Subagent";
				const model = args.model?.split("/").at(-1);
				return { id: tool.call, task, model, state };
			})
			: []
	);
}

function facts(channel: Listing, info?: ChannelInfo): DetailsFact[] {
	const root = info?.chats.find((value) => value.id === chat);
	const model = root?.model || channel.model;
	// "off" also stands for an always-thinking provider's default, so it isn't shown as a level.
	const effort = root?.model && root.effort !== "off" ? root.effort : undefined;
	const usage = info?.chats.reduce(
		(sum, value) => ({
			cost: sum.cost + (value.usage?.cost || 0),
			tokens: sum.tokens + (value.usage?.totalTokens || 0),
		}),
		{ cost: 0, tokens: 0 },
	);
	return [
		{
			label: "Project",
			value: channel.repo || channel.project.split("/").at(-1) || channel.project,
			title: channel.project,
		},
		...(channel.hosted
			? [
				{ label: "Hosted", value: new URL(channel.hosted).host, title: channel.hosted },
				{ label: "Workspace", value: channel.host },
			]
			: [{ label: "Host", value: channel.host }]),
		{ label: "Owner", value: channel.owner.split("@")[0]!, title: channel.owner },
		...(model
			? [{
				label: "Model",
				value: effort ? `${model.modelId} · ${EFFORTS[effort]}` : model.modelId,
				title: `${model.provider}/${model.modelId}${effort ? `, ${EFFORTS[effort]} effort` : ""}`,
			}]
			: []),
		...(usage?.tokens
			? [
				{ label: "Tokens", value: compact.format(usage.tokens) },
				{ label: "Estimated cost", value: dollars.format(usage.cost) },
			]
			: []),
		{ label: "Created", value: date.format(channel.created) },
	];
}

/**
 * A hosted channel's chat and model-only runs continue without its workspace; its tools wait for
 * it (#349). Hosted listings never go offline, so only another listing from the workspace can say
 * it is unreachable.
 */
function workspace(channel: Listing, channels: Listing[]): string | undefined {
	if (!channel.hosted) return;
	const away = channels.some((value) => value.host === channel.host && value.state === "offline");
	if (away) {
		return `${channel.host} is offline, so tools wait for it. Chat and model-only runs continue.`;
	}
	return `Tools run on ${channel.host} and wait while it's offline. Chat and model-only runs continue.`;
}

// Last read per repo and branch, so switching back to a channel shows its pull request at once.
const pulls = new Map<string, GithubPull | null>();

/**
 * The newest pull request from the chat's branch, read again while it can be seen. Opening a pull
 * request doesn't move the head, so a run ending reads it again too.
 */
function usePull(
	repo: string | undefined,
	branch: string | undefined,
	head: string | undefined,
	busy: boolean,
	open: boolean,
) {
	const [, render] = useReducer((count: number) => count + 1, 0);
	const key = repo && branch ? `${repo}\0${branch}` : undefined;
	useEffect(() => {
		if (!open || !repo || !branch) return;
		let active = true;
		const read = () =>
			host.request<GithubPull | null>({ op: "github-pull", repo, branch }).then(
				(value) => {
					pulls.set(`${repo}\0${branch}`, value);
					if (active) render();
				},
				() => {},
			);
		void read();
		const timer = setInterval(read, PULL);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [open, repo, branch, head, busy]);
	return key ? pulls.get(key) : undefined;
}

export function ChannelDetails({ channel }: { channel: Listing }) {
	const right = useLayoutRight();
	const details = useDetails(channel.id);
	const channels = useSyncExternalStore(host.subscribe, () => host.channels);
	const { changes, info, items } = details;
	const busy = !!info?.chats.find((value) => value.id === chat)?.busy;
	const pull = usePull(channel.repo, changes?.branch, changes?.head, busy, right.open);
	const totals = useMemo(() => {
		if (!changes) return;
		// Totaled per group as the Diff does, so uncommitted and untracked files never inflate the
		// committed work a pull request would show.
		const groups = new Map<string | undefined, DetailsChanges>();
		const add = (group: string | undefined, adds: number, dels: number, files: number) => {
			let sum = groups.get(group);
			if (!sum) {
				groups.set(group, sum = { ...(group ? { group } : {}), adds: 0, dels: 0, files: 0 });
			}
			sum.adds += adds;
			sum.dels += dels;
			sum.files += files;
		};
		for (const file of changes.files) {
			add(file.state && GROUPS[file.state], file.adds, file.dels, 1);
		}
		for (const { files } of changes.dirs || []) add(GROUPS.untracked, 0, 0, files);
		return groups.size ? [...groups.values()] : [{ adds: 0, dels: 0, files: 0 }];
	}, [changes]);
	const mentioned = useMemo(() => items && links(items, channel.repo), [items, channel.repo]);
	const agents = useMemo(() => items && subagents(items, busy), [items, busy]);
	return (
		<Sidebar
			side="right"
			id="channel-details"
			className="-my-2 h-[calc(100%+1rem)]"
			innerClassName="h-full min-h-0"
		>
			<SessionDetailsView
				summary={channel.summary}
				changes={totals}
				branch={changes?.branch}
				pull={pull}
				subagents={agents}
				links={mentioned?.filter((link) => link.url !== pull?.url)}
				facts={facts(channel, info)}
				note={workspace(channel, channels)}
				onDiff={details.diff}
				onClose={() => right.setOpen(false)}
			/>
		</Sidebar>
	);
}

/** A channel's tabs: its chat, plus Diff and Terminal views of that chat's lane. */
export function Channel(
	{ channel, channels, user, remote, draft, onDraftLoaded, onSettings, onOpen }: Props,
) {
	const [changed, setChanged] = useState<boolean>();
	const check = useRef({ busy: false, again: false });

	// One check at a time; work that lands during a check asks for one more after it.
	const inspect = useCallback(() => {
		const run = check.current;
		if (run.busy) {
			run.again = true;
			return;
		}
		run.busy = true;
		host.channel<Changes>(channel.id, { op: "changes", chat }).then(
			(changes) => {
				setChanged(changes.files.length > 0 || !!changes.dirs);
				publish(channel.id, { changes });
			},
			() => {},
		).finally(() => {
			run.busy = false;
			if (!run.again) return;
			run.again = false;
			inspect();
		});
	}, [channel.id]);

	const opener = useRef<() => void>(undefined);
	useEffect(() => {
		publish(channel.id, { diff: () => opener.current?.() });
		return () => forget(channel.id);
	}, [channel.id]);

	return (
		<Layout
			id={channel.id}
			name={channel.hosted
				? `${channel.name} · hosted`
				: remote
				? `${channel.name} · ${channel.host}`
				: channel.name}
			icon={channel.hosted ? IconCloud : undefined}
			chat={chat}
			changed={changed}
			opener={opener}
			actions={<ChannelAccess channel={channel} user={user} />}
			render={(data, uid, active, update) => {
				if (uid === CHAT) {
					return (
						<Conversation
							channel={channel}
							channels={channels}
							chat={chat}
							user={user}
							draft={draft?.channel === channel.id ? draft.text : undefined}
							onDraftLoaded={onDraftLoaded}
							onSettings={!remote && !channel.hosted ? onSettings : undefined}
							onOpen={onOpen}
							onWork={inspect}
						/>
					);
				}
				if (data.type === "diff") {
					return <Diff channel={channel.id} chat={data.chat} active={active} />;
				}
				if (data.type !== "terminal") return null;
				return (
					<Terminal
						channel={channel.id}
						chat={data.chat}
						active={active}
						terminal={data.terminal}
						onTerminal={(terminal) => update({ terminal })}
					/>
				);
			}}
			onTabClose={(_, data) => {
				if (data.type !== "terminal" || !data.terminal) return;
				host.request({ op: "terminal-close", terminal: data.terminal }).catch(() => {});
			}}
		/>
	);
}
