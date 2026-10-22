import { useRef } from "react";
import { TextSelection } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";

const MAX = 10;

/** A stored history entry: the document JSON plus the mode it was sent in. */
type Entry = { doc: Record<string, unknown>; mode?: string };

/**
 * Normalize a raw stored value into an Entry. Earlier versions stored the bare
 * document JSON (`{ type: "doc", ... }`); read those as a modeless entry.
 */
function entry(raw: Record<string, unknown>): Entry {
	if (raw.type === "doc") return { doc: raw };
	return raw as Entry;
}

function clear(view: EditorView) {
	let { schema } = view.state;
	let empty = schema.node("doc", null, [schema.node("paragraph")]);
	let tr = view.state.tr
		.replaceWith(0, view.state.doc.content.size, empty.content)
		.setMeta("addToHistory", false);
	view.dispatch(tr);
}

/** Ace mode's empty composer still holds its `@ace` chip, so mentions alone count as empty. */
function blank(doc: Node) {
	let text = "";
	doc.descendants((node) => {
		if (node.type.name === "mention") return false;
		if (node.isText) text += node.text;
		else if (node.isLeaf && node.isInline) text += "x";
	});
	return !text.trim();
}

/**
 * Navigate sent-message history with ArrowUp/ArrowDown.
 * Only starts when input is empty. Call `reset` on onChange to exit history mode.
 */
function useHistory(scope?: string) {
	let k = `ace:history:${scope || location.pathname}`;
	let index = useRef(-1);
	// A recall dispatches a change like typing does; this keeps that change from ending browsing.
	let recalling = useRef(false);
	// The mode before browsing, restored when ↓ returns to an empty composer.
	let origin = useRef<string>(undefined);

	function recall(write: () => void) {
		recalling.current = true;
		try {
			write();
		} finally {
			recalling.current = false;
		}
	}

	function load(): Entry[] {
		try {
			let raw = localStorage.getItem(k);
			return raw ? (JSON.parse(raw) as Record<string, unknown>[]).map(entry) : [];
		} catch {
			return [];
		}
	}

	function apply(view: EditorView, json: Record<string, unknown>) {
		// Dispatch a transaction (rather than view.updateState) so dispatchTransaction
		// runs and onUpdate fires — that's what the composer's mention-detector
		// listens to. updateState would silently swap the doc without notifying.
		// `addToHistory: false` keeps the recall out of the undo stack so undo
		// behaves like the previous updateState-based implementation.
		let doc = view.state.schema.nodeFromJSON(json);
		let tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
		tr.setSelection(TextSelection.atEnd(tr.doc));
		tr.setMeta("addToHistory", false);
		view.dispatch(tr);
	}

	/** Add current document (and the mode it was sent in) to history. Call on send. */
	function push(view: EditorView, mode?: string) {
		if (!view.state.doc.textContent) return;
		let items = load();
		items.push({ doc: view.state.doc.toJSON(), mode });
		if (items.length > MAX) items = items.slice(-MAX);
		try {
			localStorage.setItem(k, JSON.stringify(items));
		} catch {}
		index.current = -1;
	}

	/**
	 * ProseMirror key handler for history navigation. `onMode` receives the mode
	 * a recalled entry was sent in (`mode`, the one before browsing, when returning to an empty box) so
	 * the composer can restore mode state alongside the document.
	 */
	function handleKey(
		view: EditorView,
		e: KeyboardEvent,
		onMode?: (mode?: string) => void,
		mode?: string,
	): boolean {
		if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;

		let browsing = index.current !== -1;
		if (!browsing && !blank(view.state.doc)) return false;

		let items = load();
		if (!items.length) return false;

		if (e.key === "ArrowUp") {
			let next = browsing ? index.current - 1 : items.length - 1;
			if (next < 0) return browsing;
			e.preventDefault();
			if (!browsing) origin.current = mode;
			index.current = next;
			recall(() => {
				apply(view, items[next]!.doc);
				onMode?.(items[next]!.mode);
			});
			return true;
		}

		if (e.key === "ArrowDown") {
			if (!browsing) return false;
			e.preventDefault();
			let next = index.current + 1;
			if (next >= items.length) {
				index.current = -1;
				recall(() => {
					clear(view);
					onMode?.(origin.current);
				});
				return true;
			}
			index.current = next;
			recall(() => {
				apply(view, items[next]!.doc);
				onMode?.(items[next]!.mode);
			});
			return true;
		}

		return false;
	}

	/** Reset browsing index. Call on onChange to exit history mode. */
	function reset() {
		if (recalling.current) return;
		index.current = -1;
	}

	return { push, handleKey, reset };
}

export { useHistory };
