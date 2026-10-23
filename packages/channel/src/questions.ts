import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineDoc,
	defineExtension,
	defineTool,
	type Extension,
	type Harness,
	InboxDoc,
	type InboxState,
	LiveDoc,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";

import type { Answer } from "./protocol";
import * as room from "./room";

const MAX_CUSTOM = 4000;

type Item = {
	header: string;
	question: string;
	options: { label: string; description: string }[];
	multiple: boolean;
};

type Answered = { question: string; choices: string[] } | { question: string; custom: string };

/** Who answered, or with `skipped`, who declined to; a skip records no answers. */
type Recorded = { author: string; at: number; answers: Answered[]; skipped?: true };

/** Each `question` call's items and, once someone submits, their answers; keyed by call ID. */
export const QuestionsDoc = defineDoc<{
	questions: Record<string, {
		items: Item[];
		answer?: Recorded;
	}>;
}>({
	kind: "ace.questions",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ questions: {} }),
});

const Parameters = Type.Object({
	questions: Type.Array(
		Type.Object({
			header: Type.String({ minLength: 1, maxLength: 80, description: "A short tab label" }),
			question: Type.String({ minLength: 1, maxLength: 1000 }),
			options: Type.Array(
				Type.Object({
					label: Type.String({ minLength: 1, maxLength: 200 }),
					description: Type.String({ maxLength: 1000 }),
				}, { additionalProperties: false }),
				{ minItems: 1, maxItems: 20 },
			),
			multiple: Type.Boolean({ description: "Whether more than one option may be chosen" }),
		}, { additionalProperties: false }),
		{ minItems: 1, maxItems: 10 },
	),
}, { additionalProperties: false });

function dismissed(author: string): ToolExecutionResult {
	return {
		content: [{
			type: "text",
			text:
				`Not answered: ${author} sent a message to this chat instead. Read it before asking again.`,
		}],
	};
}

/** The author of a chat's first queued input, which a person sends instead of answering. */
function queued(state: Readonly<InboxState> | null | undefined): string | undefined {
	return (state?.items || []).flatMap((item) =>
		item.mode === "write" ? [] : [room.input(item.content).author]
	)[0];
}

/**
 * The agent asks the chat's participants and waits on a question card. The pending record and any
 * answer live in `QuestionsDoc`, so a rerun after a restart finds both instead of asking again.
 * Stop and Kill abort the wait; a queued message dismisses it, so the run reads that message
 * instead of blocking it behind the question.
 */
export class Questions {
	#queued = new Map<ConversationId, string>();
	#waiting = new Map<ConversationId, Set<(author: string) => void>>();
	#onAsk: (chat: ConversationId, phase: "question" | "answered") => void;

	/** `onAsk` hears when a chat starts waiting on a question and when an answer or message ends it. */
	constructor(onAsk: (chat: ConversationId, phase: "question" | "answered") => void) {
		this.#onAsk = onAsk;
	}

	inbox(chat: ConversationId, state: InboxState | null | undefined) {
		const author = queued(state);
		if (!author) return void this.#queued.delete(chat);
		this.#queued.set(chat, author);
		for (const dismiss of this.#waiting.get(chat) || []) dismiss(author);
	}

	readonly extension: Extension = defineExtension({
		name: "ace-questions",
		tools: [
			defineTool({
				name: "question",
				description:
					"Ask the people in this chat one or more multiple-choice questions and wait for their answer. Each question also accepts a custom written answer. Ask only when you are blocked on a decision that is theirs to make, and batch related questions into one call.",
				parameters: Parameters,
				// A rerun finds the question it recorded, or the answer someone already gave.
				replay: "safe",
				execute: async (args, api, context) => {
					const chat = api.conversationId;
					const call = api.callId;
					const { promise, resolve, reject } = Promise.withResolvers<ToolExecutionResult>();
					const dismiss = (author: string) => resolve(dismissed(author));
					// Listen before reading the inbox, so a message queued in between is not missed.
					let waiting = this.#waiting.get(chat);
					if (!waiting) this.#waiting.set(chat, waiting = new Set());
					waiting.add(dismiss);
					try {
						const before = this.#queued.get(chat)
							|| queued(await api.snapshot(InboxDoc, chat, context));
						if (before) return dismissed(before);
						const created = await api.commit(async (tx) => {
							const doc = await tx.doc(QuestionsDoc, chat);
							if (doc.questions[call]) return false;
							doc.questions[call] = { items: args.questions };
							return true;
						}, context);
						if (created) this.#onAsk(chat, "question");
						const watch = (await api.watchDoc(QuestionsDoc, chat, context))!;
						const settle = (value: typeof watch.value) => {
							const answer = value?.questions[call]?.answer;
							if (answer) resolve(answered(answer));
						};
						const abort = () => reject(context.abortSignal!.reason);
						context.abortSignal?.addEventListener("abort", abort, { once: true });
						try {
							if (context.abortSignal?.aborted) abort();
							settle(watch.value);
							watch.start(async (value) => settle(value));
							const result = await promise;
							this.#onAsk(chat, "answered");
							return result;
						} finally {
							context.abortSignal?.removeEventListener("abort", abort);
							await watch.stop();
						}
					} finally {
						waiting.delete(dismiss);
						if (!waiting.size) this.#waiting.delete(chat);
					}
				},
			}),
		],
		sections: [{
			key: "ace-questions",
			render: () =>
				"When you need a decision from the people in this chat, use the question tool instead of ending your turn with a question. People may answer by sending a message instead; if they do, read it and continue.",
		}],
	});
}

function answered(answer: Recorded): ToolExecutionResult {
	if (answer.skipped) {
		return {
			content: [{
				type: "text",
				text:
					`Not answered: ${answer.author} skipped the question. Continue without their answer, or explain what you need before asking again.`,
			}],
		};
	}
	return {
		content: [{
			type: "text",
			text: JSON.stringify({ answeredBy: answer.author, answers: answer.answers }),
		}],
	};
}

/**
 * Record `answers` to a pending question, or with `answers` null, that `author` skipped it; the
 * first submission wins. A written `answers` string answers every item with that text, and with no
 * `call`, the chat's newest open question.
 */
export async function answer(
	harness: Harness,
	chat: ConversationId,
	call: string | undefined,
	author: string,
	answers: readonly Answer[] | string | null,
	context: Context,
): Promise<void> {
	const live = await harness.snapshot(LiveDoc, chat, context);
	// A slot pi has not resumed yet after a restart still takes the answer its rerun will find.
	const open = (value: { name: string; status: string }) =>
		value.name === "question" && value.status !== "done";
	const slot = call === undefined
		? live?.tools?.findLast(open)
		: live?.tools?.find((value) => value.callId === call);
	if (!slot || !open(slot)) {
		throw new Error(
			call === undefined ? "No question is waiting" : "This question is no longer open",
		);
	}
	await harness.commit(async (tx) => {
		const doc = await tx.doc(QuestionsDoc, chat);
		const pending = doc.questions[slot.callId];
		if (!pending) throw new Error("This question is no longer open");
		if (pending.answer) throw new Error(`Already answered by ${pending.answer.author}`);
		if (answers === null) {
			pending.answer = { author, at: Date.now(), answers: [], skipped: true };
			return;
		}
		const given = typeof answers === "string"
			? pending.items.map((): Answer => ({ custom: answers }))
			: answers;
		if (given.length !== pending.items.length) throw new Error("Answer every question");
		const recorded = pending.items.map((item, index): Answered => {
			const value = given[index]!;
			if ("custom" in value) {
				const custom = value.custom.trim();
				if (!custom) throw new Error(`${item.header} needs an answer`);
				if (custom.length > MAX_CUSTOM) {
					throw new Error(`${item.header} is longer than ${MAX_CUSTOM} characters`);
				}
				return { question: item.question, custom };
			}
			const choices = [...new Set(value.choices)].map((choice) => item.options[choice]?.label);
			if (!choices.length || choices.some((label) => label === undefined)) {
				throw new Error(`${item.header} needs an answer`);
			}
			if (!item.multiple && choices.length > 1) {
				throw new Error(`${item.header} takes one answer`);
			}
			return { question: item.question, choices: choices as string[] };
		});
		pending.answer = { author, at: Date.now(), answers: recorded };
	}, context);
}
