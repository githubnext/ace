import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	type ConversationView,
	type EntryDraft,
	type Harness,
	InboxDoc,
	type InboxState,
	type SubmissionId,
} from "@earendil-works/pi-durable";

import type { QueuedMessage } from "./protocol";
import { input, MessageEntry } from "./room";

/** Project pi's inbox, including passive human writes but not internal writes such as compaction. */
export function queue(view: ConversationView): QueuedMessage[] {
	const inbox = view.docs[InboxDoc.definition.kind] as InboxState | undefined;
	return (inbox?.items || []).flatMap((item): QueuedMessage[] => {
		if (item.mode !== "write") {
			return [{ submission: item.id, ...input(item.content), invoked: true }];
		}
		const entry = item.entry as unknown as EntryDraft;
		if (entry.kind !== MessageEntry.kind) return [];
		const message = entry.model?.[0];
		if (message?.role !== "user") return [];
		return [{ submission: item.id, ...input(message.content), invoked: false }];
	});
}

/**
 * Inputs that left the inbox without reaching the transcript. pi withdraws every queued input on
 * Stop and settles each `unanswered` with no entry, and keeps none of their content, so the
 * previous snapshot is the only copy clients can get back.
 */
export async function withdrawn(
	harness: Harness,
	before: QueuedMessage[],
	after: QueuedMessage[],
): Promise<QueuedMessage[]> {
	const kept = new Set(after.map((message) => message.submission));
	const left = before.filter((message) => message.invoked && !kept.has(message.submission));
	const records = await Promise.all(
		left.map(async ({ submission }) =>
			(await harness.submission(submission as SubmissionId, context))?.status(context)
		),
	);
	return left.filter((_, index) => {
		const record = records[index];
		return record?.status === "unanswered" && record.entry === undefined;
	});
}
