import { useRef } from "react";

import { assign } from "../components/composer/format";
import { type Doc, flatten } from "./use-draft";

const MAX = 10;

/** A sent message's text plus the mode it was sent in. */
type Entry = { text: string; mode?: string };

/**
 * Normalize a stored value. Earlier versions stored rich-text document JSON, first bare
 * (`{ type: "doc", ... }`) and then as `{ doc, mode }`.
 */
function entry(raw: Doc & { doc?: Doc; mode?: string; text?: string }): Entry {
	if (raw.type === "doc") return { text: flatten(raw) };
	if (raw.doc) return { text: flatten(raw.doc), mode: raw.mode };
	return { text: raw.text || "", mode: raw.mode };
}

/**
 * Navigate sent-message history with ArrowUp/ArrowDown.
 * Only starts from an empty draft. Call `reset` on change to exit history mode.
 */
function useHistory(scope?: string) {
	let k = `ace:history:${scope || location.pathname}`;
	let index = useRef(-1);

	function load(): Entry[] {
		try {
			let raw = localStorage.getItem(k);
			return raw ? (JSON.parse(raw) as Parameters<typeof entry>[0][]).map(entry) : [];
		} catch {
			return [];
		}
	}

	/** Add sent text (and the mode it was sent in) to history. Call on send. */
	function push(text: string, mode?: string) {
		if (!text.trim()) return;
		let items = load();
		items.push({ text, mode });
		if (items.length > MAX) items = items.slice(-MAX);
		try {
			localStorage.setItem(k, JSON.stringify(items));
		} catch {}
		index.current = -1;
	}

	/**
	 * Key handler for history navigation; `empty` says whether the draft holds any words of its
	 * own. `onMode` receives the mode a recalled entry was sent in
	 * (undefined when returning to an empty box) so the composer can restore it alongside the text.
	 */
	function handleKey(
		el: HTMLTextAreaElement,
		e: { key: string; preventDefault(): void },
		empty: boolean,
		onMode?: (mode?: string) => void,
	): boolean {
		if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;

		let browsing = index.current !== -1;
		if (!browsing && !empty) return false;

		let items = load();
		if (!items.length) return false;

		if (e.key === "ArrowUp") {
			let next = browsing ? index.current - 1 : items.length - 1;
			if (next < 0) return browsing;
			e.preventDefault();
			recall(el, items[next]!, next);
			onMode?.(items[next]!.mode);
			return true;
		}

		if (!browsing) return false;
		e.preventDefault();
		let next = index.current + 1;
		if (next >= items.length) {
			assign(el, "");
			index.current = -1;
			onMode?.(undefined);
			return true;
		}
		recall(el, items[next]!, next);
		onMode?.(items[next]!.mode);
		return true;
	}

	function recall(el: HTMLTextAreaElement, item: Entry, at: number) {
		assign(el, item.text);
		// Assigning fires the change that resets browsing; the recalled position outlives it.
		index.current = at;
	}

	/** Reset browsing index. Call on change to exit history mode. */
	function reset() {
		index.current = -1;
	}

	return { push, handleKey, reset };
}

export { useHistory };
