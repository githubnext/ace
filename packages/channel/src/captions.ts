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
 * Captions describe groups of consecutive tool calls, keyed by each group's first call; `done`
 * marks a finished group's final, past-tense caption. Recaps describe all the work since a human
 * message, keyed by its first call. `calls` lists every call the text describes.
 */
export const CaptionsDoc = defineDoc<{
	groups: Record<string, { calls: string[]; text: string; done: boolean }>;
	recaps: Record<string, { calls: string[]; text: string }>;
}>({
	kind: "ace.captions",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ groups: {}, recaps: {} }),
});

/** Cheap, quick models in preference order; the chat's own provider is tried first. */
export const FAST = [
	"anthropic/claude-haiku-4-5",
	"openai/gpt-6-luna",
	"openai-codex/gpt-6-luna",
	"github-copilot/claude-haiku-4.5",
	"github-copilot/gpt-6-luna",
	"google/gemini-flash-lite-latest",
];

/** A recap runs once per run and is read first, so it gets a stronger model. */
export const STRONG = [
	"anthropic/claude-sonnet-5-5",
	"openai/gpt-6-sol",
	"openai-codex/gpt-6-sol",
	"github-copilot/claude-sonnet-5.5",
	"github-copilot/gpt-6-sol",
	"google/gemini-3.8-flash",
];

export async function pick(models: Models, ids: string[], chat?: ModelRef) {
	const ordered = chat
		? [
			...ids.filter((id) => id.startsWith(`${chat.provider}/`)),
			...ids.filter((id) => !id.startsWith(`${chat.provider}/`)),
		]
		: ids;
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

/** The agent's work after one human message: its narration and tool groups in order. */
export type Segment = {
	request: string;
	steps: ({ text: string } | { group: Group })[];
	groups: Group[];
	/** What the agent said after its last tool call. */
	answer: string;
	/** A human message or the run's end follows it. */
	closed: boolean;
};

/**
 * The newest two segments: work a steering message cut short still gets its last captions and
 * recap, and older transcripts are not captioned after the fact.
 */
export function segments(messages: readonly Message[], running: boolean): Segment[] {
	const found: Segment[] = [];
	const results = new Map<string, { text: string; error: boolean }>();
	let segment: Segment | undefined;
	let current: Group | undefined;
	let narration = "";
	for (const message of messages) {
		if (message.role === "user") {
			if (current) current.closed = true;
			if (segment) segment.closed = true;
			segment = { request: plain(message), steps: [], groups: [], answer: "", closed: false };
			found.push(segment);
			current = undefined;
			narration = "";
			continue;
		}
		if (message.role === "toolResult") {
			results.set(message.toolCallId, { text: plain(message), error: message.isError });
			continue;
		}
		if (message.role !== "assistant" || !segment) continue;
		for (const block of message.content) {
			if (block.type === "text" && block.text.trim()) {
				if (current) current.closed = true;
				current = undefined;
				narration = block.text.trim();
				segment.steps.push({ text: narration });
				segment.answer += `${segment.answer ? "\n\n" : ""}${narration}`;
			}
			if (block.type !== "toolCall") continue;
			if (!current) {
				current = { calls: [], narration, closed: false };
				segment.groups.push(current);
				segment.steps.push({ group: current });
			}
			segment.answer = "";
			current.calls.push({ id: block.id, name: block.name, args: block.arguments });
		}
	}
	if (!running) {
		if (current) current.closed = true;
		if (segment) segment.closed = true;
	}
	const recent = found.slice(-2);
	for (const { groups } of recent) {
		for (const group of groups) {
			for (const call of group.calls) {
				const result = results.get(call.id);
				if (!result) continue;
				call.result = result.text;
				call.error = result.error;
			}
		}
	}
	return recent;
}

/** Recaption a growing group when it doubles, and once more in the past tense when it closes. */
export function isStale(group: Group, stored?: { calls: string[]; done: boolean }): boolean {
	if (!stored) return true;
	if (group.closed) return !stored.done;
	return group.calls.length >= stored.calls.length * 2;
}

const CAPTION =
	`You label steps in an AI coding agent's work log. Each step is a group of tool calls that the log folds under one line. Write that line: what the agent did in this step, and toward what, in sentence case. Keep it under seven words; shorter is better.

Name the specific thing (component, file, feature, or goal), never generic phrases like "Ran commands" or "Used tools". Describe this step, not the whole task. Reply with the line only: no quotes, preamble, or trailing punctuation.`;

const RUNNING =
	`The step is still running: start with a present participle, as in "Investigating whether the editor causes the bug", "Editing the composer", or "Updating the repo and opening a PR".`;

const DONE =
	`The step has finished: start with a past-tense verb, as in "Investigated whether the editor causes the bug", "Edited the composer", or "Updated the repo and opened a PR".`;

export async function caption(
	models: Models,
	model: Model<any>,
	request: string,
	group: Group,
	previous: string[],
	signal: AbortSignal,
) {
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
	const reply = await complete(
		models,
		model,
		`${CAPTION}\n\n${group.closed ? DONE : RUNNING}`,
		input,
		60,
		signal,
	);
	const text = reply.text.trim().split("\n")[0]!.replace(/^["'“]+|["'”.:;…]+$/g, "").trim();
	if (!text) throw new Error("The model replied with no caption");
	return { text: clip(text, 100), usage: reply.usage };
}

const RECAP =
	`You summarize an AI coding agent's work for the folded section of a chat transcript. The section holds the agent's narration and tool calls; its final answer is shown separately, right below the section. Write what the agent did to get there, so a reader can skip the section.

Write one or two plain sentences, at most 40 words, in the past tense without a subject, such as "Traced how new chats choose a model through the composer, channel, and host defaults, then found where the CLI prints tool results." Be specific: name the files, components, and commands that mattered, and outcomes like failing checks, commits, or an opened pull request. Don't repeat the final answer's explanation. Reply with the summary only: no markdown, quotes, or preamble.`;

export async function recap(
	models: Models,
	model: Model<any>,
	segment: Segment,
	captions: Record<string, { text: string }>,
	signal: AbortSignal,
) {
	let budget = 80;
	const log = segment.steps.map((step) => {
		if ("text" in step) return `Agent: ${clip(step.text, 600)}`;
		const { calls } = step.group;
		const shown = calls.slice(0, Math.max(3, budget));
		budget -= shown.length;
		const label = captions[calls[0]!.id]?.text;
		return [
			`Step${label ? `: ${label}` : ""}`,
			...shown.map((call) =>
				`- ${call.name} ${clip(JSON.stringify(call.args), 160)}${call.error ? " (error)" : ""}`
			),
			...(shown.length < calls.length ? [`- … ${calls.length - shown.length} more`] : []),
		].join("\n");
	});
	const input = [
		`Request: ${clip(segment.request, 2000)}`,
		`Work log:\n${log.join("\n\n")}`,
		segment.answer && `Final answer (shown separately): ${clip(segment.answer, 1500)}`,
	].filter(Boolean).join("\n\n");
	const reply = await complete(models, model, RECAP, input, 300, signal);
	const text = reply.text.trim().replace(/^["“]+|["”]+$/g, "");
	if (!text) throw new Error("The model replied with no recap");
	return { text: clip(text, 400), usage: reply.usage };
}

async function complete(
	models: Models,
	model: Model<any>,
	systemPrompt: string,
	input: string,
	maxTokens: number,
	signal: AbortSignal,
) {
	// Thinking makes these several times slower; use the least a model allows.
	const levels = getSupportedThinkingLevels(model);
	const reasoning = levels.includes("off")
		? undefined
		: levels.find((level): level is ThinkingLevel => level !== "off");
	const reply: AssistantMessage = await models.completeSimple(model, {
		systemPrompt,
		messages: [{ role: "user", content: input, timestamp: Date.now() }],
	}, {
		maxTokens: reasoning ? maxTokens + 2000 : maxTokens,
		signal,
		...(reasoning ? { reasoning } : {}),
	});
	if (reply.stopReason === "error" || reply.stopReason === "aborted") {
		throw new Error(reply.errorMessage || `Caption ${reply.stopReason}`);
	}
	const text = reply.content.flatMap((block) => block.type === "text" ? [block.text] : [])
		.join("");
	return { text, usage: reply.usage };
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
