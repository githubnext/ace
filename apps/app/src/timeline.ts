import type { Listing, People } from "@ace/host/protocol";
import type { Event } from "@ace/ui";

import type { Item, Tool } from "./transcript";

const AGENT = "ace:agent";
const MENTION = /(?<=^|\s)@([a-zA-Z0-9_-]+)/g;

/**
 * Channels on the viewed channel's host keyed by the author their agent's messages carry. The prefix
 * outlives renames, so messages sent before one still find their channel.
 */
export function sources(channels: Listing[], host: string): Map<string, Listing> {
	return new Map(
		channels.flatMap((channel) =>
			channel.host === host && channel.prefix ? [[`agent@${channel.prefix}`, channel]] : []
		),
	);
}

/**
 * Human authors are Tailscale logins; without a known GitHub login, the name before the domain
 * reads as a handle. Agent authors name the chat or channel after the `@`, so they stay whole.
 */
export function authorName(
	author: string,
	people: People,
	channels: Map<string, Listing>,
): string {
	const source = channels.get(author);
	if (source) return `#${source.name}`;
	if (author.startsWith("agent@")) return author;
	return people[author] || author.split("@")[0]!;
}

function text(value: string): Event.Message.Content.Text {
	const parts = [...value.matchAll(MENTION)].map((match) => ({
		type: "mention" as const,
		value: match[1]!,
		index: match.index,
	}));
	return parts.length ? { type: "text", text: value, parts } : { type: "text", text: value };
}

function tool(
	tool: Tool,
	busy: boolean,
	caption?: string,
	recap?: string,
): Event.Message.Content.Tool {
	const status = tool.result ? (tool.result.error ? "error" : "success") : busy ? "start" : "error";
	return {
		type: "tool",
		id: tool.call,
		name: tool.name,
		arguments: (tool.args ?? {}) as Record<string, unknown>,
		status,
		...(caption ? { caption } : {}),
		...(recap ? { recap } : {}),
		...(tool.result
			? {
				result: {
					content: tool.result.text,
					...(tool.result.images
						? {
							images: tool.result.images.map((image) =>
								`data:${image.mimeType};base64,${image.data}`
							),
						}
						: {}),
				},
			}
			: {}),
		...(!tool.result && tool.progress
			? {
				result: {
					content: tool.progress.truncated
						? `… earlier output not shown\n${tool.progress.text}`
						: tool.progress.text,
				},
			}
			: {}),
	};
}

/**
 * Channel transcript items in the shape the original timeline renders. The streamed draft joins
 * the timeline as the newest agent message so it is laid out and scrolled like the rest.
 */
export function toEvents(
	items: Item[],
	topic: string,
	busy: boolean,
	draft: { text: string; model?: string },
	people: People,
	channels: Map<string, Listing>,
	captions: Record<string, string>,
	recaps: Record<string, string>,
): Event[] {
	const events = items.map((item) => {
		const base = {
			id: `${topic}::${item.key}`,
			uid: item.key,
			type: "message",
			topic,
			created_at: Math.floor(item.at / 1000),
		} as const;
		if (item.kind === "message") {
			return {
				...base,
				sender: {
					kind: "user",
					value: item.author,
					display: authorName(item.author, people, channels),
				},
				content: [
					text(item.invoked && !/(^|\s)@ace\b/i.test(item.text) ? `@ace ${item.text}` : item.text),
					...(item.images || []).map((image) => ({
						type: "image" as const,
						image: `data:${image.mimeType};base64,${image.data}`,
					})),
				],
			} as Event;
		}
		// Models narrate before calling tools, so the text introduces the group that follows it.
		const content: Event.Message.Agent["content"] = item.text ? [text(item.text)] : [];
		for (const call of item.tools) {
			content.push(tool(call, busy, captions[call.call], recaps[call.call]));
		}
		for (const call of item.tools) {
			if (call.result?.interrupted) {
				content.push(
					text(`The channel restarted while ${call.name} ran, so it may have partially run.`),
				);
			}
			if (call.result?.handoff) {
				content.push(text(`Stopped ${call.name} for a message from another channel.`));
			}
		}
		if (item.error) content.push(text(`Run failed: ${item.error}`));
		if (item.stopped) content.push(text("Stopped."));
		return {
			...base,
			sender: { kind: "agent", value: AGENT, display: item.model || "Agent" },
			content,
		} as Event;
	});
	if (!draft.text) return events;
	events.push({
		id: `${topic}::draft`,
		uid: "draft",
		type: "message",
		topic,
		created_at: Math.floor(Date.now() / 1000),
		sender: { kind: "agent", value: AGENT, display: draft.model || "Agent" },
		content: [text(draft.text)],
		streaming: true,
	} as Event);
	return events;
}
