import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { MENTION } from "@ace/channel/protocol";
import { Button, ChatStatus, Timeline, toast } from "@ace/ui";
import { channelProject, type Listing } from "@ace/host/protocol";

import { Checks } from "./checks";
import { Composer } from "./composer";
import { DeleteMessage } from "./delete-message";
import { desktop } from "./desktop";
import { EditMessage } from "./edit-message";
import { publish, useDetails } from "./details";
import { host } from "./host";
import { MessageQueue } from "./message-queue";
import { OfflineHost, useRoster } from "./onboarding";
import { present } from "./presence";
import { pendingQuestion, Question } from "./question";
import { credit, sources, toEvents } from "./timeline";
import { useTranscript, useTyping } from "./transcript";
import { Usage } from "./usage";

const stopped = (who: string) => `${who} isn't responding. The chat continues when it answers.`;

type Props = {
	channel: Listing;
	/** Every listed channel, to name and open the channels that message this one. */
	channels: Listing[];
	chat: number;
	user: string;
	/** Others' messages after `since` and up to `until` arrived while this person was away. */
	unread?: { since?: number; until?: number };
	draft?: string;
	onDraftLoaded: () => void;
	onProviders?: () => void;
	onOpen: (channel: Listing) => void;
	/** Called once the chat loads and whenever its agent may have changed files since. */
	onWork?: () => void;
};

/** One chat's timeline and composer over its transcript; the content of a Chat tab. */
export function Conversation(
	{
		channel,
		channels,
		chat: id,
		user,
		unread,
		draft,
		onDraftLoaded,
		onProviders,
		onOpen,
		onWork,
	}: Props,
) {
	const offline = channel.state === "offline";
	const placement = channel.hosted || channel.host;
	const moving = channel.moving && `Moving to ${channel.moving}…`;
	const computing = channel.computing
		&& `${channel.computing === "starting" ? "Starting" : "Stopping"} the cloud workspace…`;
	const transition = moving || computing;
	// The service refuses a computing channel, so the chat is watched again only once that ends.
	const transcript = useTranscript(
		computing ? undefined : channel.id,
		id,
		offline,
		channel.moving ? `${placement} → ${channel.moving}` : placement,
	);
	// The watch retries once the host is back or the move or compute transition ends, so its error
	// until then is not the user's to retry.
	const failed = !offline && !transition && transcript.error;
	const chat = transcript.info?.chats.find((value) => value.id === id);
	const { diff } = useDetails(channel.id);
	const model = chat?.model || channel.model;
	const people = useSyncExternalStore(host.subscribe, () => host.people);
	// This app's own host, or the peer host relaying this channel to it, stopped answering.
	const stalled = useSyncExternalStore(host.subscribe, () => host.stalled);
	const notice = stalled
		? stopped(desktop ? "Ace Helper" : "Your host")
		: channel.stalled
		? stopped(channel.host)
		: channel.state === "archived"
			&& (channel.owner === user
				? "Archived. Unarchive it from the sidebar to send messages."
				: "Archived. Only its owner can unarchive it.");
	const waiting = stalled
		? `Waiting for ${desktop ? "Ace Helper" : "your host"}`
		: channel.stalled
		? `Waiting for ${channel.host}`
		: channel.state === "dormant"
		? "Starting channel"
		: "Sending";
	const reply = transcript.items.findLast((item) => item.kind === "reply");
	const question = reply?.kind === "reply" && pendingQuestion(reply.tools, transcript.busy);
	const last = transcript.items.at(-1);
	const failure = !transcript.busy && last?.kind === "reply" ? last.error : undefined;
	const senders = useMemo(() => sources(channels, channel.host), [channels, channel.host]);
	const events = useMemo(
		() =>
			toEvents(
				transcript.items,
				channel.id,
				transcript.busy,
				{
					text: transcript.draft,
					model: model?.modelId,
				},
				people,
				senders,
				transcript.captions,
				transcript.recaps,
				transcript.reactions,
				(asker) => credit(asker, channel, user, people, senders),
			),
		[
			transcript.items,
			channel.id,
			transcript.busy,
			transcript.draft,
			model,
			people,
			senders,
			transcript.captions,
			transcript.recaps,
			transcript.reactions,
			channel,
			user,
		],
	);
	const byKey = useMemo(
		() => new Map(transcript.items.map((item) => [item.key, item])),
		[transcript.items],
	);
	const { since, until = 0 } = unread || {};
	const first = since === undefined
		? undefined
		: transcript.items.find((item) =>
			item.kind === "message" && item.author !== user && item.at > since && item.at <= until
		)?.key;
	// Mentions name people by GitHub login, as the channel's host counts them.
	const self = people[user]?.toLowerCase();
	const mentioned = useMemo(
		() =>
			new Set(
				self
					? transcript.items.flatMap((item) =>
						item.kind === "message" && item.author !== user && !item.deleted
							&& [...item.text.matchAll(MENTION)].some((match) => match[1]!.toLowerCase() === self)
							? [item.key]
							: []
					)
					: [],
			),
		[transcript.items, user, self],
	);
	// Reactions and deletions target stored entries; the streamed draft and tool-only replies have none.
	const actions = (uid: string) => {
		const item = byKey.get(uid);
		const stored = item?.entry !== undefined && !(item.kind === "message" && item.deleted);
		// An archived channel refuses changes to its history.
		const open = stored && channel.state !== "archived";
		return { react: open, copy: stored && !!item.text, delete: open, permalink: false };
	};
	const [deleting, setDeleting] = useState<string>();
	// Only a person's own stored messages are edited, and an archived channel refuses edits.
	const editable = useMemo(
		() =>
			new Set(
				channel.state === "archived"
					? []
					: transcript.items.flatMap((item) =>
						item.kind === "message" && item.author === user && !item.deleted ? [item.key] : []
					),
			),
		[transcript.items, user, channel.state],
	);
	const [editing, setEditing] = useState<string>();
	const edited = editing === undefined || !editable.has(editing) ? undefined : byKey.get(editing);
	const act = (
		request: { op: "react"; emoji: string; remove: boolean } | { op: "delete" },
		uid: string,
	) => {
		const entry = byKey.get(uid)!.entry!;
		host.channel(channel.id, { ...request, chat: id, author: user, entry }).catch((error: Error) =>
			toast.error(
				request.op === "react" ? "Could not react" : "Could not delete the message",
				{ description: error.message },
			)
		);
	};
	// Keyed by Tailscale login for message authors and by GitHub login for mentions.
	const avatars = useMemo(
		() =>
			Object.fromEntries(
				Object.entries(people).flatMap(([login, github]) => {
					const src = `https://github.com/${github}.png?size=64`;
					return [[login, src], [github, src]];
				}),
			),
		[people],
	);
	const presence = useSyncExternalStore(host.subscribe, () => host.presence);
	const roster = useRoster();
	// Mentions name people by GitHub login. A name still holding @ is a Tailscale login with no
	// GitHub account, or an agent from another channel (`agent@<prefix>`), and can't be mentioned.
	const members = useMemo(() => {
		const self = people[user] || user;
		const names = new Set([
			...present(presence[channelProject(channel)], self, channel.id).map((value) => value.name),
			...transcript.items.flatMap((item) =>
				item.kind === "message" ? [people[item.author] || item.author] : []
			),
			...(roster || []).map((member) => member.github || member.login),
		]);
		return [...names]
			.filter((name) => name !== self && name !== "ace" && !name.includes("@"))
			.map((name) => ({ name, avatar: avatars[name] }));
	}, [people, user, presence, channel, transcript.items, roster, avatars]);
	const typing = useTyping(transcript.typing).filter((author) => author !== user)
		.map((author) => people[author] || author);
	const results = useMemo(
		() =>
			transcript.items.reduce(
				(sum, item) =>
					item.kind === "reply" ? sum + item.tools.filter((tool) => tool.result).length : sum,
				0,
			),
		[transcript.items],
	);

	// Replay delivers one event at a time; the sidebar reads the transcript once it is complete.
	const items = transcript.live ? transcript.items : undefined;
	useEffect(() => {
		const { info, shared, sharedLive, desktop, desktopLive } = transcript;
		publish(channel.id, { info, items, shared, sharedLive, desktop, desktopLive });
	}, [
		channel.id,
		transcript.info,
		items,
		transcript.shared,
		transcript.sharedLive,
		transcript.desktop,
		transcript.desktopLive,
	]);

	useEffect(() => {
		if (transcript.live) onWork?.();
	}, [transcript.live, transcript.busy, results, onWork]);
	return (
		<>
			<div className="relative min-h-0 flex-1">
				{transcript.live
					? (
						<Timeline
							className="h-full min-h-0 contain-paint scroll-fade [--fade:3rem]"
							events={events}
							working={transcript.busy || undefined}
							currentUser={{ login: user, own: [user] }}
							unread={first}
							summary={channel.summary}
							mentioned={mentioned}
							actions={actions}
							onReact={(uid, emoji) => {
								const entry = byKey.get(uid)!.entry!;
								const remove = !!transcript.reactions[entry]?.some((value) =>
									value.from === user && value.emoji === emoji
								);
								act({ op: "react", emoji, remove }, uid);
							}}
							onCopy={(uid) =>
								navigator.clipboard.writeText(byKey.get(uid)!.text).then(
									() => toast("Copied message"),
									(error) =>
										toast.error("Could not copy the message", { description: error.message }),
								)}
							onDelete={setDeleting}
							editable={editable}
							editing={edited?.key}
							onEdit={setEditing}
							avatars={avatars}
							openSender={(sender) => {
								const source = senders.get(sender);
								return source && (() => onOpen(source));
							}}
							intro={{ name: channel.name, createdAt: Math.floor(channel.created / 1000) }}
							onFileOpen={diff}
							onDiffFileOpen={diff}
							onReviewChanges={diff && (() => diff())}
						/>
					)
					: offline
					? <OfflineHost name={channel.name} host={channel.host} />
					: (
						<div
							className="grid h-full place-content-center justify-items-center gap-3 px-6 text-center text-sm text-muted-foreground"
							role={failed ? "alert" : "status"}
						>
							<p>
								{transition
									|| failed
									|| notice
									|| (transcript.restarting
										? "Channel is restarting…"
										: channel.state === "dormant"
										? "Starting channel…"
										: "Loading chat…")}
							</p>
							{failed && <Button onClick={transcript.retry}>Try again</Button>}
						</div>
					)}
			</div>
			{deleting && (
				<DeleteMessage
					onDelete={() => {
						act({ op: "delete" }, deleting);
						setDeleting(undefined);
					}}
					onCancel={() => setDeleting(undefined)}
				/>
			)}
			<div className="utils:max-width relative z-20 shrink-0 px-3 pb-3">
				{typing.length > 0 && (
					<ChatStatus className="absolute inset-x-5 bottom-full" typing={typing} disclaimer="" />
				)}
				{transcript.live && (notice || transition || transcript.restarting) && (
					<p className="pb-2 text-center text-xs text-muted-foreground" role="status">
						{notice || transition || "Channel is restarting…"}
					</p>
				)}
				{transcript.live && question && (
					<Question
						key={question.call}
						channel={channel}
						chat={id}
						call={question}
						user={user}
						mayAnswer={channel.owner === user || transcript.shared !== false}
					/>
				)}
				{transcript.live && <Checks channel={channel} chat={id} user={user} />}
				{transcript.live && (
					<MessageQueue messages={transcript.queue} people={people} channels={senders} />
				)}
				{edited && (
					<EditMessage
						key={edited.key}
						channel={channel.id}
						chat={id}
						user={user}
						entry={edited.entry!}
						text={edited.text}
						onDone={() => setEditing(undefined)}
					/>
				)}
				{/* Hidden rather than unmounted, so its draft and attachments wait out the edit. */}
				<div className={edited ? "hidden" : "contents"}>
					<Composer
						channel={channel}
						chat={id}
						user={user}
						current={model}
						currentEffort={chat?.effort}
						automatic={transcript.info?.automatic}
						busy={transcript.busy}
						waiting={waiting}
						shared={transcript.shared}
						ready={transcript.live && !transition && channel.state !== "archived"}
						draft={draft}
						onDraftLoaded={onDraftLoaded}
						returned={transcript.returned}
						failure={failure}
						onProviders={onProviders}
						accessory={chat?.usage && <Usage value={chat.usage} context={chat.context} />}
						members={members}
					/>
				</div>
			</div>
		</>
	);
}
