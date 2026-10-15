import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import {
	type ConversationId,
	defineExtension,
	type Extension,
	type InboxState,
	type ToolExecutionResult,
	wrapTool,
} from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";

import { type Directory, senders } from "./agents";
import * as room from "./room";

/** Marks a shell result that a queued handoff stopped or skipped. */
export const HANDOFF = "handoff";

function result(message: string): ToolExecutionResult {
	return { isError: true, diagnostics: [{ severity: "error", code: HANDOFF, message }] };
}

/**
 * Another channel's agent invokes a chat to hand it work, often while that chat's agent waits for
 * it in a shell loop. Its queued input stops the chat's running shell commands, and skips new ones,
 * until pi places it as a steer after the current tool round, so the run continues with the
 * message and reruns nothing. Only shell commands are interrupted: other tools may be mid-change,
 * and a person has Stop.
 */
export class Handoffs {
	/** The author of each chat's queued handoff, from pi's inbox commits. */
	#queued = new Map<ConversationId, string>();
	#running = new Map<ConversationId, Set<(author: string) => void>>();

	#directory: Directory;

	constructor(directory: Directory) {
		this.#directory = directory;
	}

	/** Read when the result is written, since the sender's author keeps its original name. */
	async #sender(author: string, context: Context): Promise<string> {
		return (await senders(this.#directory, context)).get(author) || author;
	}

	inbox(chat: ConversationId, state: InboxState | null | undefined) {
		const author = (state?.items || []).flatMap((item) =>
			item.mode === "write" ? [] : [room.input(item.content).author]
		).find(room.isAgent);
		if (!author) return void this.#queued.delete(chat);
		this.#queued.set(chat, author);
		for (const stop of this.#running.get(chat) || []) stop(author);
	}

	readonly extension: Extension = defineExtension({
		name: "ace-handoffs",
		wraps: [
			wrapTool(createBashTool(), (tool) => ({
				...tool,
				execute: async (args, api, context) => {
					const chat = api.conversationId;
					const queued = this.#queued.get(chat);
					if (queued) {
						return result(
							`Not run: ${await this.#sender(queued, context)} sent a message to this chat.`,
						);
					}
					const { context: command, cancel } = withCancel(context);
					let by: string | undefined;
					const stop = (author: string) => {
						by ||= author;
						cancel();
					};
					let running = this.#running.get(chat);
					if (!running) this.#running.set(chat, running = new Set());
					running.add(stop);
					try {
						return await tool.execute(args, api, command);
					} catch (error) {
						if (!by || context.abortSignal?.aborted) throw error;
						return result(
							`Stopped: ${await this.#sender(by, context)} sent a message to this chat.`,
						);
					} finally {
						running.delete(stop);
						if (!running.size) this.#running.delete(chat);
					}
				},
			})),
		],
	});
}
