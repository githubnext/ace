import { useEffect, useMemo, useSyncExternalStore } from "react";

import { Button, Timeline } from "@ace/ui";
import type { Listing } from "@ace/host/protocol";

import { Composer } from "./composer";
import { desktop } from "./desktop";
import { publish } from "./details";
import { host } from "./host";
import { MessageQueue } from "./message-queue";
import { sources, toEvents } from "./timeline";
import { useTranscript } from "./transcript";
import { Usage } from "./usage";

const stopped = (who: string) => `${who} isn't responding. The chat continues when it answers.`;

type Props = {
	channel: Listing;
	/** Every listed channel, to name and open the channels that message this one. */
	channels: Listing[];
	chat: number;
	user: string;
	draft?: string;
	onDraftLoaded: () => void;
	onSettings?: () => void;
	onOpen: (channel: Listing) => void;
	/** Called once the chat loads and whenever its agent may have changed files since. */
	onWork?: () => void;
};

/** One chat's timeline and composer over its transcript; the content of a Chat tab. */
export function Conversation(
	{ channel, channels, chat: id, user, draft, onDraftLoaded, onSettings, onOpen, onWork }: Props,
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
	const model = chat?.model || channel.model;
	const people = useSyncExternalStore(host.subscribe, () => host.people);
	// This app's own host, or the peer host relaying this channel to it, stopped answering.
	const stalled = useSyncExternalStore(host.subscribe, () => host.stalled);
	const notice = stalled
		? stopped(desktop ? "Ace Helper" : "Your host")
		: channel.stalled && stopped(channel.host);
	const waiting = stalled
		? `Waiting for ${desktop ? "Ace Helper" : "your host"}`
		: channel.stalled
		? `Waiting for ${channel.host}`
		: channel.state === "dormant"
		? "Starting channel"
		: "Sending";
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
		],
	);
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
							toolbar={false}
							working={transcript.busy || undefined}
							currentUser={{ login: user }}
							avatars={avatars}
							openSender={(sender) => {
								const source = senders.get(sender);
								return source && (() => onOpen(source));
							}}
							intro={{ name: channel.name, createdAt: Math.floor(channel.created / 1000) }}
						/>
					)
					: (
						<div
							className="grid h-full place-content-center justify-items-center gap-3 px-6 text-center text-sm text-muted-foreground"
							role={failed ? "alert" : "status"}
						>
							<p>
								{offline
									? `Offline: ${channel.host} is unreachable. This chat loads when it's back.`
									: transition
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
			<div className="utils:max-width relative z-20 shrink-0 px-3 pb-3">
				{transcript.live && (notice || transition || transcript.restarting) && (
					<p className="pb-2 text-center text-xs text-muted-foreground" role="status">
						{notice || transition || "Channel is restarting…"}
					</p>
				)}
				{transcript.live && (
					<MessageQueue messages={transcript.queue} people={people} channels={senders} />
				)}
				<Composer
					channel={channel}
					chat={id}
					user={user}
					current={model}
					currentEffort={chat?.effort}
					busy={transcript.busy}
					waiting={waiting}
					shared={transcript.shared}
					ready={transcript.live && !transition && channel.state !== "archived"}
					draft={draft}
					onDraftLoaded={onDraftLoaded}
					returned={transcript.returned}
					onSettings={onSettings}
					accessory={chat?.usage && <Usage value={chat.usage} context={chat.context} />}
				/>
			</div>
		</>
	);
}
