/**
 * ace demo's only model: an agent answers a scripted ask with the step's reply, streamed like a
 * model's, so the demo reads no keys and reaches no provider.
 */
import { readFileSync } from "node:fs";

import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type FauxResponseFactory,
	fauxText,
	fauxThinking,
	type Message,
	type MutableModels,
} from "@earendil-works/pi-ai";

import type { Script } from "./demo";

export const DEMO_MODEL = "demo/agent";

const FALLBACK =
	"This is ace demo, so no model runs here: the teammates and the agent's replies come from its script. In a real channel I'd work on this in a lane of the project and answer here.";

/** More than the runs a demo has at once; the provider takes one queued reply per call. */
const QUEUED = 8;

function asked(messages: Message[]): string {
	const message = messages.findLast((value) => value.role === "user");
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
}

export function models(file: string): MutableModels {
	const script = JSON.parse(readFileSync(file, "utf8")) as Script;
	const asks = script.steps.flatMap((step) => "ask" in step && step.reply ? [step] : []);
	const [provider, id] = DEMO_MODEL.split("/") as [string, string];
	const faux = fauxProvider({
		api: provider,
		provider,
		models: [{ id, name: "Demo agent" }],
		tokensPerSecond: 30,
	});
	const reply: FauxResponseFactory = (context) => {
		faux.appendResponses([reply]);
		const text = asked(context.messages);
		const step = asks.find((value) => text.includes(value.ask));
		if (!step?.reply) return fauxAssistantMessage(FALLBACK);
		return fauxAssistantMessage([
			...step.thinking ? [fauxThinking(step.thinking)] : [],
			fauxText(step.reply),
		]);
	};
	faux.setResponses(Array.from({ length: QUEUED }, () => reply));
	const found = createModels();
	found.setProvider(faux.provider);
	return found;
}
