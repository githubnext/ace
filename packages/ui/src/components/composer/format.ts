import { isUrl } from "../../lib/utils";

type Format =
	| "bold"
	| "italic"
	| "underline"
	| "strike"
	| "code"
	| "pre"
	| "link"
	| "bullet"
	| "ordered"
	| "quote";

const MARKS = {
	bold: ["**", "**"],
	italic: ["_", "_"],
	underline: ["<u>", "</u>"],
	strike: ["~~", "~~"],
	code: ["`", "`"],
} as const;

const PREFIXES = { bullet: /^- /, ordered: /^\d+\. /, quote: /^> / } as const;

/**
 * Replace `from..to` through the browser's editing command, so the change joins the textarea's
 * native undo stack and fires `input` like typing does.
 */
function edit(el: HTMLTextAreaElement, from: number, to: number, text: string) {
	el.focus();
	el.setSelectionRange(from, to);
	if (text) document.execCommand("insertText", false, text);
	else if (from < to) document.execCommand("delete");
}

/** Replace the whole text outside the undo stack, as recalling a draft or switching modes does. */
function assign(el: HTMLTextAreaElement, text: string, at = text.length) {
	el.value = text;
	el.setSelectionRange(at, at);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Replace `from..to`, then select `start..end` relative to `from`. */
function put(
	el: HTMLTextAreaElement,
	from: number,
	to: number,
	text: string,
	start: number,
	end = start,
) {
	edit(el, from, to, text);
	el.setSelectionRange(from + start, from + end);
}

/** Toggle an inline marker pair around the selection. */
function mark(el: HTMLTextAreaElement, [open, close]: readonly [string, string]) {
	let { value, selectionStart: from, selectionEnd: to } = el;
	let inner = value.slice(from, to);
	if (
		value.slice(from - open.length, from) === open && value.slice(to, to + close.length) === close
	) {
		return put(el, from - open.length, to + close.length, inner, 0, inner.length);
	}
	if (
		inner.startsWith(open) && inner.endsWith(close) && inner.length >= open.length + close.length
	) {
		let bare = inner.slice(open.length, inner.length - close.length);
		return put(el, from, to, bare, 0, bare.length);
	}
	put(el, from, to, open + inner + close, open.length, open.length + inner.length);
}

/** Toggle a line prefix on every line the selection touches. */
function prefix(el: HTMLTextAreaElement, kind: keyof typeof PREFIXES) {
	let { value, selectionStart, selectionEnd } = el;
	let from = value.lastIndexOf("\n", selectionStart - 1) + 1;
	let end = value.indexOf("\n", selectionEnd);
	let to = end === -1 ? value.length : end;
	let lines = value.slice(from, to).split("\n");
	let re = PREFIXES[kind];
	let off = lines.every(line => re.test(line));
	let next = lines.map((line, i) => {
		if (off) return line.replace(re, "");
		let bare = line.replace(/^(?:- |\d+\. |> )/, "");
		return (kind === "bullet" ? "- " : kind === "quote" ? "> " : `${i + 1}. `) + bare;
	}).join("\n");
	put(el, from, to, next, next.length);
}

/** Toggle a fenced code block around the lines the selection touches. */
function fence(el: HTMLTextAreaElement) {
	let { value, selectionStart, selectionEnd } = el;
	let from = value.lastIndexOf("\n", selectionStart - 1) + 1;
	let end = value.indexOf("\n", selectionEnd);
	let to = end === -1 ? value.length : end;
	let inner = value.slice(from, to);
	let fenced = /^```[^\n]*\n([\s\S]*)\n```$/.exec(inner);
	if (fenced) return put(el, from, to, fenced[1]!, fenced[1]!.length);
	put(el, from, to, "```\n" + inner + "\n```", 4, 4 + inner.length);
}

/** Wrap the selection as a link, selecting the part still to fill in. */
function link(el: HTMLTextAreaElement, href = "") {
	let { value, selectionStart: from, selectionEnd: to } = el;
	let text = value.slice(from, to);
	if (!href && isUrl(text)) return put(el, from, to, `[](${text})`, 1);
	let url = href || "url";
	let start = text.length + 3;
	put(el, from, to, `[${text}](${url})`, href ? start + url.length + 1 : start, start + url.length);
}

function format(el: HTMLTextAreaElement, kind: Format) {
	if (kind === "pre") return fence(el);
	if (kind === "link") return link(el);
	if (kind in PREFIXES) return prefix(el, kind as keyof typeof PREFIXES);
	mark(el, MARKS[kind as keyof typeof MARKS]);
}

export { assign, edit, type Format, format, link };
