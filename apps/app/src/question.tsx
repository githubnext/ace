import { useMemo, useRef, useState } from "react";

import {
	Button,
	isAnswered,
	type QuestionDraft,
	QuestionInput,
	type QuestionItem,
	QuestionView,
	type QuestionViewHandle,
} from "@ace/ui";
import type { Answer } from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";

import { host } from "./host";
import type { Tool } from "./transcript";

type Args = {
	questions: {
		header: string;
		question: string;
		options: { label: string; description: string }[];
		multiple: boolean;
	}[];
};

const EMPTY: QuestionDraft[string] = { mode: "choices", choice: null, options: {}, custom: "" };

/** The newest `question` call still waiting for its result, if the run is. */
export function pendingQuestion(tools: Tool[], busy: boolean): Tool | undefined {
	if (!busy) return;
	return tools.findLast((tool) => tool.name === "question" && !tool.result);
}

/** Answers the agent's pending question; the first submission in the chat wins. */
export function Question({ channel, chat, call, user, mayAnswer }: {
	channel: Listing;
	chat: number;
	call: Tool;
	user: string;
	mayAnswer: boolean;
}) {
	const questions = useMemo<QuestionItem[]>(
		() =>
			(call.args as Args).questions.map((item, index) => ({
				id: `q${index}`,
				header: item.header,
				question: item.question,
				multiple: item.multiple,
				options: item.options.map((option, choice) => ({ id: `o${choice}`, ...option })),
			})),
		[call.args],
	);
	const [draft, setDraft] = useState<QuestionDraft>({});
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string>();
	const handle = useRef<QuestionViewHandle>(null);

	const entry = (id: string, value = draft) => value[id] || EMPTY;
	const update = (
		id: string,
		change: (current: QuestionDraft[string]) => Partial<QuestionDraft[string]>,
	) =>
		setDraft((value) => {
			const current = entry(id, value);
			return { ...value, [id]: { ...current, ...change(current) } };
		});

	async function send(request: { op: "answer"; answers: Answer[] } | { op: "skip" }) {
		setSubmitting(true);
		setError(undefined);
		try {
			await host.channel(channel.id, { ...request, chat, call: call.call, author: user });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setSubmitting(false);
		}
	}

	async function submit() {
		const missing = questions.find((question) => !isAnswered(question, draft[question.id]));
		if (missing) return handle.current?.invalid(missing.id);
		const answers = questions.map((question): Answer => {
			const answer = entry(question.id);
			if (answer.mode === "custom") return { custom: answer.custom };
			return {
				choices: question.options.flatMap((option, index) =>
					(question.multiple ? answer.options[option.id] : answer.choice === option.id)
						? [index]
						: []
				),
			};
		});
		await send({ op: "answer", answers });
	}

	return (
		<QuestionView
			id={call.call}
			count={1}
			requester="the agent"
			handle={handle}
			form={{
				definition: { questions },
				view: draft,
				disabled: !mayAnswer || submitting,
				submitting,
				error,
				...(mayAnswer ? {} : { status: "Only the channel owner can answer here" }),
				actions: (
					<Button
						size="sm"
						variant="secondary"
						disabled={!mayAnswer || submitting}
						onClick={() => void send({ op: "skip" })}
					>
						Skip
					</Button>
				),
				choose: (id, option, multiple, checked) =>
					update(id, (current) =>
						multiple
							? { mode: "choices", options: { ...current.options, [option]: checked } }
							: { mode: "choices", choice: option }),
				custom: (question) => (
					<QuestionInput
						label={question.header}
						name={`question-${call.call}-${question.id}`}
						active={entry(question.id).mode === "custom"}
						value={entry(question.id).custom}
						disabled={!mayAnswer || submitting}
						onActive={() => update(question.id, () => ({ mode: "custom" }))}
						onChange={(custom) => update(question.id, () => ({ mode: "custom", custom }))}
					/>
				),
				submit,
			}}
		/>
	);
}
