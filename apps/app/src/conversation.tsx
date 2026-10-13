import { useEffect, useMemo, useSyncExternalStore } from "react";

import { Button, Timeline } from "@ace/ui";
import type { Listing } from "@ace/host/protocol";

import { Composer } from "./composer";
import { publish } from "./details";
import { host } from "./host";
import { MessageQueue } from "./message-queue";
import { toEvents } from "./timeline";
import { useTranscript } from "./transcript";
import { Usage } from "./usage";

type Props = {
	channel: Listing;
	chat: number;
	user: string;
	draft?: string;
	onDraftLoaded: () => void;
	onSettings?: () => void;
	/** Called once the chat loads and whenever its agent may have changed files since. */
	onWork?: () => void;
};

/** One chat's timeline and composer over its transcript; the content of a Chat tab. */
export function Conversation(
	{ channel, chat: id, user, draft, onDraftLoaded, onSettings, onWork }: Props,
) {
	const transcript = useTranscript(
		channel.id,
		id,
		channel.state === "offline",
		channel.hosted || channel.host,
	);
	const chat = transcript.info?.chats.find((value) => value.id === id);
	const model = chat?.model || channel.model;
	const people = useSyncExternalStore(host.subscribe, () => host.people);
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
				transcript.captions,
			),
		[
			transcript.items,
			channel.id,
			transcript.busy,
			transcript.draft,
			model,
			people,
			transcript.captions,
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
							intro={{ name: channel.name, createdAt: Math.floor(channel.created / 1000) }}
						/>
					)
					: (
						<div
							className="grid h-full place-content-center justify-items-center gap-3 px-6 text-center text-sm text-muted-foreground"
							role={transcript.error ? "alert" : "status"}
						>
							<p>
								{transcript.error
									|| (channel.state === "dormant" ? "Starting channel…" : "Loading chat…")}
							</p>
							{transcript.error && <Button onClick={transcript.retry}>Try again</Button>}
						</div>
					)}
			</div>
			<div className="utils:max-width relative z-20 shrink-0 px-3 pb-3">
				{transcript.live && <MessageQueue messages={transcript.queue} />}
				<Composer
					channel={channel}
					chat={id}
					user={user}
					current={model}
					currentEffort={chat?.effort}
					busy={transcript.busy}
					shared={transcript.shared}
					ready={transcript.live && channel.state !== "archived"}
					draft={draft}
					onDraftLoaded={onDraftLoaded}
					onSettings={onSettings}
					accessory={chat?.usage && <Usage value={chat.usage} context={chat.context} />}
				/>
			</div>
		</>
	);
}
