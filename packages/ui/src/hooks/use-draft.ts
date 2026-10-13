import { useMemo } from "react";

/** Storage can be full or unavailable; a failed write must never break editor input. */
function attempt(fn: () => void): boolean {
	try {
		fn();
		return true;
	} catch {
		return false;
	}
}

function get(store: "localStorage" | "sessionStorage", key: string): string | null {
	try {
		return window[store].getItem(key);
	} catch {
		return null;
	}
}

function remove(key: string) {
	attempt(() => localStorage.removeItem(key));
	attempt(() => sessionStorage.removeItem(key));
}

type Doc = { type?: string; text?: string; attrs?: { name?: string }; content?: Doc[] };

/**
 * Drafts and recalled messages were rich-text documents stored as JSON before the composer
 * edited markdown source; keep their words.
 */
function flatten(node: Doc): string {
	if (node.type === "text") return node.text || "";
	if (node.type === "hard_break") return "\n";
	if (node.type === "mention") return `@${node.attrs?.name}`;
	if (node.type === "emoji") return `:${node.attrs?.name}:`;
	if (node.type === "document") return `&${node.attrs?.name}`;
	if (node.type === "plan") return "&plan.md";
	let inline = node.type === "paragraph" || node.type === "heading" || node.type === "code_block";
	return (node.content || []).map(flatten).join(inline ? "" : "\n\n");
}

/**
 * Read a saved draft. Earlier versions kept drafts in sessionStorage. A durable draft wins;
 * otherwise a live legacy draft moves to localStorage. The legacy copy is dropped only once a
 * durable one exists, so a failed write keeps it and a later clear cannot resurrect it.
 */
function read(key: string): string | undefined {
	let raw = get("localStorage", key);
	const legacy = get("sessionStorage", key);
	if (legacy !== null) {
		let durable = raw !== null || attempt(() => localStorage.setItem(key, legacy));
		if (durable) attempt(() => sessionStorage.removeItem(key));
		raw ||= legacy;
	}
	if (!raw) return undefined;
	try {
		let doc = JSON.parse(raw) as Doc | null;
		return doc?.type === "doc" ? flatten(doc) : raw;
	} catch {
		return raw;
	}
}

/**
 * Persist composer input to localStorage, scoped by key (defaults to pathname), so drafts
 * survive a browser or app restart. Every edit is written synchronously: a quit can follow the
 * last keystroke immediately, and neither timers nor unmount run then. Call `clear` on send.
 */
function useDraft(scope?: string) {
	let k = `ace:draft:${scope || location.pathname}`;
	let initial = useMemo(() => read(k), [k]);

	/** Save the text. Removes the key when empty. */
	function save(text: string) {
		if (!text.trim()) return remove(k);
		attempt(() => localStorage.setItem(k, text));
	}

	/** Clear draft immediately. */
	function clear() {
		remove(k);
	}

	return { defaultValue: initial, save, clear };
}

export { type Doc, flatten, useDraft };
