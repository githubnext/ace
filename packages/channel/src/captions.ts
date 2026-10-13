import {
	type AssistantMessage,
	getSupportedThinkingLevels,
	type Message,
	type Model,
	type Models,
	type ThinkingLevel,
	type Usage,
} from "@earendil-works/pi-ai";
import { defineDoc, type UsageState } from "@earendil-works/pi-durable";

import type { ModelRef } from "./protocol";

/**
 * One line per group of consecutive tool calls, keyed by the group's first call. `calls` is
 * every call the caption describes, so a group that grew since is captioned again.
 */
export const CaptionsDoc = defineDoc<
	{ groups: Record<string, { calls: string[]; text: string }> }
>({
	kind: "ace.captions",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ groups: {} }),
});

/** Cheap, quick models in preference order; the chat's own provider is tried first. */
const FAST = [
	"anthropic/claude-haiku-4-5",
	"openai/gpt-6-luna",
	"openai-codex/gpt-6-luna",
	"github-copilot/claude-haiku-4.5",
	"github-copilot/gpt-6-luna",
	"google/gemini-flash-lite-latest",
];

export async function fast(models: Models, chat?: ModelRef) {
	const ordered = chat
		? [
			...FAST.filter((id) => id.startsWith(`${chat.provider}/`)),
			...FAST.filter((id) => !id.startsWith(`${chat.provider}/`)),
		]
		: FAST;
	const available = new Map<string, Set<string>>();
	for (const id of ordered) {
		const [provider, modelId] = id.split("/") as [string, string];
		if (!available.has(provider)) {
			const found = await models.getAvailable(provider).catch(() => []);
			available.set(provider, new Set(found.map((model) => model.id)));
		}
		if (available.get(provider)!.has(modelId)) return models.getModel(provider, modelId);
	}
}

type Call = { id: string; name: string; args: unknown; result?: string; error?: boolean };

export type Group = {
	calls: Call[];
	/** What the agent said just before the group. */
	narration: string;
	/** Text, a human message, or the run's end follows it, so it will not grow. */
	closed: boolean;
};

/** Tool call groups since the newest human input, in the order the timeline shows them. */
export function groups(messages: readonly Message[], running: boolean) {
	let start = messages.length;
	while (start > 0 && messages[start - 1]!.role !== "user") start--;
	const request = start > 0 ? plain(messages[start - 1]!) : "";
	const found: Group[] = [];
	const results = new Map<string, { text: string; error: boolean }>();
	let current: Group | undefined;
	let narration = "";
	for (const message of messages.slice(start)) {
		if (message.role === "toolResult") {
			results.set(message.toolCallId, { text: plain(message), error: message.isError });
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "text" && block.text.trim()) {
				if (current) current.closed = true;
				current = undefined;
				narration = block.text.trim();
			}
			if (block.type !== "toolCall") continue;
			if (!current) {
				current = { calls: [], narration, closed: false };
				found.push(current);
			}
			current.calls.push({ id: block.id, name: block.name, args: block.arguments });
		}
	}
	if (current && !running) current.closed = true;
	for (const group of found) {
		for (const call of group.calls) {
			const result = results.get(call.id);
			if (!result) continue;
			call.result = result.text;
			call.error = result.error;
		}
	}
	return { request, groups: found };
}

/** Recaption a growing group only when it doubles, and once more when it closes. */
export function isStale(group: Group, captioned?: number): boolean {
	if (!captioned) return true;
	const count = group.calls.length;
	if (count <= captioned) return false;
	return group.closed || count >= captioned * 2;
}

const PROMPT =
	`You label steps in an AI coding agent's work log. Each step is a group of tool calls that the log folds under one line. Write that line: what the agent is doing in this step, and toward what, as a present-participle phrase in sentence case. Keep it under seven words; shorter is better.

Examples: "Investigating whether the editor causes the bug", "Editing the composer", "Wiring captions into the timeline", "Updating the repo and opening a PR".

Name the specific thing (component, file, feature, or goal), never generic phrases like "Running commands" or "Using tools". Describe this step, not the whole task. Reply with the line only: no quotes, preamble, or trailing punctuation.`;

export async function caption(
	models: Models,
	model: Model<any>,
	request: string,
	group: Group,
	previous: string[],
	signal: AbortSignal,
): Promise<{ text: string; usage: Usage }> {
	const calls = group.calls.slice(-30).map((call) => {
		const result = call.result === undefined
			? "(running)"
			: `${call.error ? "error: " : ""}${clip(call.result, 200)}`;
		return `- ${call.name} ${clip(JSON.stringify(call.args), 300)}\n  → ${result}`;
	});
	const omitted = group.calls.length - calls.length;
	const input = [
		`Request: ${clip(request, 1000)}`,
		previous.length && `Earlier steps:\n${previous.map((line) => `- ${line}`).join("\n")}`,
		group.narration && `The agent said before this step: ${clip(group.narration, 800)}`,
		`Tool calls in this step${omitted ? ` (latest 30 of ${group.calls.length})` : ""}:\n${
			calls.join("\n")
		}`,
	].filter(Boolean).join("\n\n");
	// Thinking makes a one-line caption several times slower; use the least a model allows.
	const levels = getSupportedThinkingLevels(model);
	const reasoning = levels.includes("off")
		? undefined
		: levels.find((level): level is ThinkingLevel => level !== "off");
	const reply: AssistantMessage = await models.completeSimple(model, {
		systemPrompt: PROMPT,
		messages: [{ role: "user", content: input, timestamp: Date.now() }],
	}, {
		maxTokens: reasoning ? 2000 : 60,
		signal,
		...(reasoning ? { reasoning } : {}),
	});
	if (reply.stopReason === "error" || reply.stopReason === "aborted") {
		throw new Error(reply.errorMessage || `Caption ${reply.stopReason}`);
	}
	const text = reply.content.flatMap((block) => block.type === "text" ? [block.text] : [])
		.join("").trim().split("\n")[0]!
		.replace(/^["'“]+|["'”.…:;]+$/g, "")
		.trim();
	if (!text) throw new Error("Caption was empty");
	return { text: clip(text, 100), usage: reply.usage };
}

/** Adds to the conversation's ledger like a tool's spend, so usage totals include captions. */
export function spend(state: UsageState, usage: Usage): void {
	state.tools.caption ||= {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	// Assigning stores a copy; only the draft read back records changes.
	const total = state.tools.caption;
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

function plain(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

function clip(text: string, length: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}
