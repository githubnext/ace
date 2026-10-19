import { Type } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineExtension,
	defineTool,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";

import type { Metadata } from "./protocol";

export const MetadataDoc = defineDoc<
	Metadata & { named: boolean; lastTask: number }
>({
	kind: "ace.metadata",
	version: 1,
	scope: "session",
	initial: () => ({ name: "", summary: "", revision: 0, named: false, lastTask: 0 }),
});

export const MetadataExtension = defineExtension({ name: "ace-metadata" });

export function validateName(value: string): string {
	const name = value.trim();
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
		throw new Error("A channel name must be lowercase kebab-case, at most 63 characters");
	}
	return name;
}

export function metadata(
	changed: (value: Metadata) => void,
	claim?: (name: string, exact: boolean) => Promise<string>,
) {
	return defineExtension({
		...MetadataExtension,
		tools: [
			defineTool({
				name: "channel",
				description:
					"Keep this channel's rolling summary current and give an unnamed channel a useful name. Only the channel's first chat can update it. Preserve an established name unless the user specifically asked you to rename the channel.",
				parameters: Type.Object({
					summary: Type.String({
						minLength: 1,
						maxLength: 1000,
						description:
							"One to three concise plain-text sentences covering the channel's purpose, current progress, important decisions, and unresolved work. Replace the previous summary; do not invent outcomes.",
					}),
					name: Type.Optional(Type.String({
						description: "Short lowercase kebab-case name, at most 63 characters",
					})),
					rename: Type.Optional(Type.Boolean({
						description:
							"Set true only when the user specifically asked you to rename an already named channel",
					})),
				}),
				replay: "safe",
				executionMode: "sequential",
				execute: async (args, api, context) => {
					if (api.conversationId !== ROOT_CONVERSATION_ID) {
						throw new Error("Only the channel's first chat can update its name and summary");
					}
					const summary = args.summary.trim();
					if (!summary || summary.length > 1000) {
						throw new Error("A channel summary must contain 1 to 1000 characters");
					}
					const name = args.name === undefined ? undefined : validateName(args.name);
					let taken = false;
					const value = await api.commit(async (tx) => {
						const doc = await tx.doc(MetadataDoc);
						// A recovered tool must not restore metadata that a later update replaced.
						if (api.taskId > doc.lastTask) {
							const previous = doc.name;
							if (name && (!doc.named || args.rename)) {
								if (name !== doc.name) doc.name = await claim?.(name, false) || name;
								doc.named = true;
								taken = doc.name !== name;
							}
							if (doc.name !== previous || doc.summary !== summary) doc.revision++;
							doc.summary = summary;
							doc.lastTask = api.taskId;
						}
						return { name: doc.name, summary: doc.summary, revision: doc.revision };
					}, context);
					changed(value);
					const text = taken
						? `Another channel is named ${name}, so this channel is named ${value.name}`
						: value.name;
					return { content: [{ type: "text", text: `${text}\n${value.summary}` }] };
				},
			}),
		],
	});
}
