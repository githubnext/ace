import { defineExtension, GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

/** Writes one structured record. Each runtime decides where records go; ids belong in `fields`. */
export type Log = (level: Level, event: string, fields?: Fields) => void;

/** Copies `fields` into every record, so a channel's lines always carry its id. */
export function scoped(log: Log, base: Fields): Log {
	return (level, event, fields) => log(level, event, { ...base, ...fields });
}

/** An error's message, code, stack, and cause, which JSON drops. */
export function failure(error: unknown): Fields {
	if (!(error instanceof Error)) return { error: String(error) };
	const fields: Fields = { error: error.message, stack: error.stack };
	if ("code" in error) fields.code = error.code;
	if (error.cause !== undefined) fields.cause = failure(error.cause);
	return fields;
}

const ARGS = 2000;

function clip(value: unknown): unknown {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > ARGS ? `${text.slice(0, ARGS)}… (${text.length} chars)` : value;
}

/**
 * Model responses and tool calls of every conversation. Hooks rerun when a crash replays a task,
 * so a replayed call logs again; `task` tells repeats apart from new work.
 */
export function logging(log: Log) {
	const started = new Map<string, number>();
	return defineExtension({
		name: "ace-log",
		hooks: [
			hook(GenerationTask, {
				beforeRequest(request, api) {
					log("debug", "model.request", {
						chat: api.conversationId,
						task: api.taskId,
						messages: request.messages.length,
					});
					return undefined;
				},
				afterResponse(message, api) {
					const failed = message.stopReason === "error";
					log(failed ? "error" : "info", "model.response", {
						chat: api.conversationId,
						task: api.taskId,
						provider: message.provider,
						model: message.model,
						stop: message.stopReason,
						...(message.errorMessage ? { error: message.errorMessage } : {}),
						usage: message.usage,
					});
				},
			}),
			hook(ToolTask, {
				beforeTool(call, api) {
					started.set(call.id, Date.now());
					log("info", "tool.start", {
						chat: api.conversationId,
						task: api.taskId,
						call: call.id,
						tool: call.name,
						args: clip(call.arguments),
					});
					return undefined;
				},
				afterTool(call, result, api) {
					const start = started.get(call.id);
					started.delete(call.id);
					log(result.isError ? "warn" : "info", "tool.end", {
						chat: api.conversationId,
						task: api.taskId,
						call: call.id,
						tool: call.name,
						error: !!result.isError,
						...(start ? { ms: Date.now() - start } : {}),
					});
					return undefined;
				},
			}),
		],
	});
}
