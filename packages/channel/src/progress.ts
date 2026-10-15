import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";

import type { ChatId, Event } from "./protocol";

/**
 * The shown tail of a running tool's output. pi keeps the larger retained window, and the result
 * entry carries it with truncation notices and the full-output path.
 */
const MAX_CHARS = 8 * 1024;
const MAX_LINES = 100;
/** Per watch, so a chatty build costs each watcher and relaying peer one window per interval. */
const INTERVAL_MS = 500;

/** `length` is pi's whole window, which front trims count against; `text` is its bounded tail. */
type Window = { text: string; length: number; truncated: boolean };

/**
 * Projects pi's live tool output for one watch as `progress` events that replace the call's
 * previous one. Nothing is stored: attachment and overflow snapshots rebuild every window.
 */
export function progress(chat: ChatId, send: (event: Event) => void) {
	const windows = new Map<string, Window>();
	const dirty = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let sent = 0;
	const flush = () => {
		timer = undefined;
		sent = Date.now();
		for (const call of dirty) {
			const { text, truncated } = windows.get(call)!;
			send({ kind: "progress", chat, call, text, ...(truncated ? { truncated } : {}) });
		}
		dirty.clear();
	};
	const schedule = () => {
		timer ||= setTimeout(flush, Math.max(0, sent + INTERVAL_MS - Date.now()));
	};
	return {
		snapshot(tools: SnapshotEvent["tools"]) {
			windows.clear();
			dirty.clear();
			for (const slot of tools) {
				if (slot.status !== "running" || !slot.output) continue;
				windows.set(
					slot.callId,
					bound({ text: slot.output, length: slot.output.length, truncated: !!slot.droppedBytes }),
				);
				dirty.add(slot.callId);
			}
			clearTimeout(timer);
			flush();
		},
		update(event: AgentEvent) {
			if (event.type === "tool_execution_end") {
				windows.delete(event.toolCallId);
				dirty.delete(event.toolCallId);
				return;
			}
			if (event.type !== "tool_execution_update" || !event.output) return;
			const window = windows.get(event.toolCallId) || { text: "", length: 0, truncated: false };
			const { output } = event;
			if ("set" in output) {
				window.text = output.set;
				window.length = output.set.length;
			} else {
				if (output.trimStart) {
					window.length -= output.trimStart;
					window.truncated = true;
					if (window.text.length > window.length) {
						window.text = window.text.slice(window.text.length - window.length);
					}
				}
				if (output.append) {
					window.text += output.append;
					window.length += output.append.length;
				}
			}
			windows.set(event.toolCallId, bound(window));
			dirty.add(event.toolCallId);
			schedule();
		},
		stop() {
			clearTimeout(timer);
		},
	};
}

/** Keeps whole lines where possible; a single overlong line keeps its tail. */
function bound(window: Window): Window {
	let { text } = window;
	if (text.length > MAX_CHARS) {
		text = text.slice(-MAX_CHARS);
		const newline = text.indexOf("\n");
		if (newline >= 0 && newline < text.length - 1) text = text.slice(newline + 1);
	}
	const lines = text.split("\n");
	if (lines.length > MAX_LINES + 1) text = lines.slice(-MAX_LINES - 1).join("\n");
	return text === window.text ? window : { ...window, text, truncated: true };
}
