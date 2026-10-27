import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	AssistantEntry,
	type ConversationId,
	type Cursor,
	type EntryDraft,
	type EntryId,
	type EntryRecord,
	type Harness,
	ROOT_CONVERSATION_ID,
	ToolResultEntry,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";

import { CaptionsDoc } from "./captions";
import { EditEntry, MessagesDoc } from "./messages";
import { MetadataDoc } from "./metadata";
import type { Effort, Image, ModelRef, Reaction, TextFile } from "./protocol";
import * as room from "./room";

/**
 * A channel's conversations as editable JSON: people's messages by author and time, and agents'
 * turns as the pi messages a real run committed. Importing appends them through pi, so the result
 * is an ordinary channel whose agents read the imported history as their context.
 */
export type Seed = {
	format: "ace-seed";
	version: 1;
	name: string;
	summary?: string;
	/** The first chat is the channel's root chat. */
	chats: SeedChat[];
};

export type SeedChat = {
	model?: ModelRef;
	effort?: Effort;
	items: SeedItem[];
	/** Tool-call captions and recaps, keyed by call ID, so imports need no captioning model. */
	captions?: { groups: Record<string, unknown>; recaps: Record<string, unknown> };
};

export type SeedItem =
	& { reactions?: Reaction[] }
	& (
		| {
			author: string;
			text: string;
			/** ISO 8601. */
			at: string;
			/** Whether the message asked the chat's agent to run. */
			invoke?: boolean;
			images?: Image[];
			files?: TextFile[];
		}
		| { agent: { kind: string; model: Message[]; data?: EntryRecord["data"] } }
	);

const AGENT = new Set([AssistantEntry.kind, ToolResultEntry.kind]);

async function history(harness: Harness, chat: ConversationId): Promise<EntryRecord[]> {
	const entries: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await harness.commit(
			(tx) => tx.scanEntries({ conversationId: chat }, 256, cursor),
			context,
		);
		entries.push(...page.items);
		cursor = page.next;
	} while (cursor);
	return entries.toReversed();
}

/**
 * People's messages as they read now, edits applied and deletions dropped, and agents' replies and
 * tool results. Subagent chats, run bookkeeping, and prompt markers stay behind.
 */
export async function exportSeed(harness: Harness): Promise<Seed> {
	const { name, summary } = (await harness.snapshot(MetadataDoc, context))!;
	const records = [];
	let cursor: Cursor | undefined;
	do {
		const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), context);
		records.push(...page.items);
		cursor = page.next;
	} while (cursor);
	const chats = await Promise.all(
		records.filter((record) => !record.owner).map(async ({ id }): Promise<SeedChat> => {
			const [agent, actions, captions, entries] = await Promise.all([
				harness.snapshot(AgentDoc, id, context),
				harness.snapshot(MessagesDoc, id, context),
				harness.snapshot(CaptionsDoc, id, context),
				history(harness, id),
			]);
			const edited = new Map<number, string>();
			for (const entry of entries) {
				if (EditEntry.is(entry)) edited.set(entry.data.target, entry.data.text);
			}
			const items = entries.flatMap((entry): SeedItem[] => {
				const reactions = actions?.reactions[entry.id];
				const extra = reactions?.length ? { reactions } : {};
				const human = room.human(entry);
				if (human) {
					if (actions?.deleted[entry.id]) return [];
					const { author, text, at, invoked, images, files } = human;
					return [{
						author,
						text: edited.get(entry.id) ?? text,
						at: new Date(at).toISOString(),
						...(invoked ? { invoke: true } : {}),
						...(images ? { images } : {}),
						...(files ? { files } : {}),
						...extra,
					}];
				}
				if (!AGENT.has(entry.kind) || !entry.model) return [];
				const data = entry.data === undefined ? {} : { data: entry.data };
				return [{ agent: { kind: entry.kind, model: [...entry.model], ...data }, ...extra }];
			});
			return {
				...(agent?.model ? { model: agent.model } : {}),
				...(agent?.thinkingLevel ? { effort: agent.thinkingLevel } : {}),
				items,
				...(captions ? { captions } : {}),
			};
		}),
	);
	return { format: "ace-seed", version: 1, name, ...(summary ? { summary } : {}), chats };
}

export function validateSeed(seed: Seed): void {
	if (seed?.format !== "ace-seed" || seed.version !== 1) {
		throw new Error("Not a version 1 Ace seed");
	}
	if (!seed.chats?.length) throw new Error("A seed needs at least one chat");
	for (const chat of seed.chats) {
		for (const item of chat.items) {
			if ("agent" in item) {
				const { kind, model } = item.agent;
				if (!AGENT.has(kind) || model?.length !== 1) {
					throw new Error(`Seeds carry only agent replies and tool results, not ${kind}`);
				}
				continue;
			}
			if (!room.isAuthor(item.author)) throw new Error(`Invalid author ${item.author}`);
			if (Number.isNaN(Date.parse(item.at))) throw new Error(`Invalid time ${item.at}`);
			room.checkAttachments(item);
		}
	}
}

/** Every time in the seed, moved by `shift` milliseconds. */
function moved(message: Message, shift: number): Message {
	return { ...message, timestamp: message.timestamp + shift } as Message;
}

async function append(tx: Tx, chat: ConversationId, seed: SeedChat, shift: number) {
	const reactions = await tx.doc(MessagesDoc, chat);
	for (const item of seed.items) {
		let draft: EntryDraft;
		if ("agent" in item) {
			const { kind, model, data } = item.agent;
			draft = { kind, model: model.map((message) => moved(message, shift)), data };
		} else {
			const at = Date.parse(item.at) + shift;
			const message = room.draft(item.author, item.text, at, item);
			draft = item.invoke ? { kind: UserEntry.kind, model: message.model } : message;
		}
		const { id } = await tx.appendEntry(chat, draft);
		if (item.reactions?.length) reactions.reactions[id as EntryId] = item.reactions;
	}
	if (seed.captions) Object.assign(await tx.doc(CaptionsDoc, chat), seed.captions);
}

/**
 * Appends a seed to a new channel whose root chat is still empty, `shift` milliseconds later than
 * the seed's own times. The channel's name is claimed by its runtime, so only the summary is set.
 */
export async function importSeed(harness: Harness, seed: Seed, shift = 0): Promise<void> {
	validateSeed(seed);
	const [root, ...rest] = seed.chats as [SeedChat, ...SeedChat[]];
	await harness.commit(async (tx) => {
		const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1);
		if (page.items.length) throw new Error("Seeds import only into a new channel");
		if (seed.summary) {
			const metadata = await tx.doc(MetadataDoc);
			metadata.summary = seed.summary;
			metadata.revision++;
		}
		await append(tx, ROOT_CONVERSATION_ID, root, shift);
	}, context);
	const conversation = await harness.conversation(ROOT_CONVERSATION_ID, context);
	if (root.model || root.effort) {
		await conversation!.configure({ model: root.model, thinkingLevel: root.effort }, context);
	}
	const { cwd } = (await harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, context))!;
	for (const chat of rest) {
		await harness.createConversation({
			ownership: { kind: "ownerless" },
			agent: { model: chat.model || root.model, thinkingLevel: chat.effort, cwd },
			init: (tx, id) => append(tx, id, chat, shift),
		}, context);
	}
}

/** The shift that moves a seed's newest time to `now`. */
export function shiftTo(seed: Seed, now: number): number {
	let newest = 0;
	for (const chat of seed.chats) {
		for (const item of chat.items) {
			const at = "agent" in item ? item.agent.model[0]!.timestamp : Date.parse(item.at);
			newest = Math.max(newest, at);
		}
	}
	return newest ? now - newest : 0;
}
