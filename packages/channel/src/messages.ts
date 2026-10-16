import type { Context } from "@earendil-works/chord";
import type { UserMessage } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineDoc,
	defineEntry,
	type EntryId,
	type EntryRecord,
	type Harness,
} from "@earendil-works/pi-durable";

import type { Reaction } from "./protocol";
import * as room from "./room";

/**
 * People's actions on a chat's messages, keyed by entry. Entries are immutable, so this is the
 * current state: each message's reactions in the order people added them (old Ace's shape), and
 * the deleted messages.
 */
export type Messages = {
	reactions: Record<string, Reaction[]>;
	deleted: Record<string, true>;
};

export const MessagesDoc = defineDoc<Messages>({
	kind: "ace.messages",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ reactions: {}, deleted: {} }),
});

/**
 * A deletion in the transcript. Its context edit replaces the message for later model requests;
 * earlier runs already read it, and pi keeps the original entry, so it stays in backups.
 */
export const DeletionEntry = defineEntry<{ author: string; target: number }>("ace.deletion");

/**
 * An edit in the transcript: the author's message now reads `text`, as of `at`. Its context edit
 * replaces the message for later model requests; the newest edit of an entry wins there and in
 * replay. Replies that answered the earlier text stay, since their runs already read it.
 */
export const EditEntry = defineEntry<{ author: string; target: number; text: string; at: number }>(
	"ace.edit",
);

const EMOJI = /^\S{1,64}$/u;

async function target(
	harness: Harness,
	chat: ConversationId,
	entry: EntryId,
	context: Context,
): Promise<EntryRecord> {
	const record = await harness.commit((tx) => tx.entry(entry), context);
	if (record?.conversationId !== chat) throw new Error(`No message ${entry} in chat ${chat}`);
	return record;
}

/** Adding or removing names the result rather than toggling, so a repeated request is a no-op. */
export async function react(
	harness: Harness,
	chat: ConversationId,
	entry: EntryId,
	{ from, emoji }: Reaction,
	remove: boolean,
	context: Context,
): Promise<void> {
	if (typeof emoji !== "string" || !EMOJI.test(emoji)) throw new Error("Invalid reaction");
	const record = await target(harness, chat, entry, context);
	if (!room.human(record) && record.model?.[0]?.role !== "assistant") {
		throw new Error("Only messages and replies take reactions");
	}
	await harness.commit(async (tx) => {
		const doc = await tx.doc(MessagesDoc, chat);
		if (doc.deleted[entry]) throw new Error("The message was deleted");
		const current = doc.reactions[entry] || [];
		const exists = current.some((value) => value.from === from && value.emoji === emoji);
		if (exists !== remove) return;
		// Assigning into a document copies the value, so build the list before assigning it.
		const reactions = remove
			? current.filter((value) => value.from !== from || value.emoji !== emoji)
			: [...current, { from, emoji }];
		if (reactions.length) doc.reactions[entry] = reactions;
		else delete doc.reactions[entry];
	}, context);
}

/** Only a message's own author deletes it; agents' replies and others' messages stay. */
export async function remove(
	harness: Harness,
	chat: ConversationId,
	entry: EntryId,
	author: string,
	context: Context,
): Promise<void> {
	const record = await target(harness, chat, entry, context);
	const human = room.human(record);
	if (!human) throw new Error("Only people's messages can be deleted");
	if (human.author !== author) throw new Error("Only a message's author can delete it");
	const message = record.model![0] as UserMessage;
	await harness.commit(async (tx) => {
		const doc = await tx.doc(MessagesDoc, chat);
		if (doc.deleted[entry]) return;
		doc.deleted[entry] = true;
		delete doc.reactions[entry];
		// The placeholder keeps the author's turn in context, so the model neither loses who spoke
		// nor sees a reply without the message it answered.
		const placeholder: UserMessage = {
			role: "user",
			content: room.content(author, "[deleted this message]"),
			timestamp: message.timestamp,
		};
		await tx.appendEntry(DeletionEntry, chat, {
			data: { author, target: entry },
			edits: [{ target: entry, action: "replace", messages: [placeholder] }],
		});
	}, context);
}

/** Only a message's own author edits it; images and files it carried stay with it. */
export async function edit(
	harness: Harness,
	chat: ConversationId,
	entry: EntryId,
	author: string,
	text: string,
	context: Context,
): Promise<void> {
	const record = await target(harness, chat, entry, context);
	const human = room.human(record);
	if (!human) throw new Error("Only people's messages can be edited");
	if (human.author !== author) throw new Error("Only a message's author can edit it");
	if (typeof text !== "string") throw new Error("Invalid text");
	const { images, files } = human;
	if (!text.trim() && !images && !files) throw new Error("A message needs text; delete it instead");
	const message = record.model![0] as UserMessage;
	await harness.commit(async (tx) => {
		const doc = await tx.doc(MessagesDoc, chat);
		if (doc.deleted[entry]) throw new Error("The message was deleted");
		const replacement: UserMessage = {
			role: "user",
			content: room.content(author, text, { images, files }),
			timestamp: message.timestamp,
		};
		await tx.appendEntry(EditEntry, chat, {
			data: { author, target: entry, text, at: Date.now() },
			edits: [{ target: entry, action: "replace", messages: [replacement] }],
		});
	}, context);
}
