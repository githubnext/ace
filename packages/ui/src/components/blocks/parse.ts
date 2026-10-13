import bash from "@shikijs/langs/bash";
import css from "@shikijs/langs/css";
import html from "@shikijs/langs/html";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsx from "@shikijs/langs/jsx";
import markdown from "@shikijs/langs/markdown";
import rust from "@shikijs/langs/rust";
import shellscript from "@shikijs/langs/shellscript";
import typescript from "@shikijs/langs/typescript";
import tsx from "@shikijs/langs/tsx";
import { type ComarkElement, type ComarkNode, createParse } from "comark";
import breaks from "comark/plugins/breaks";
import highlight from "comark/plugins/highlight";
import security from "comark/plugins/security";
import {
	type PreparedRichInline,
	prepareRichInline,
	type RichInlineItem,
} from "@chenglou/pretext/rich-inline";

import { customEmojiSrc } from "../../lib/emoji";
import { theme } from "../../lib/highlighter";
import {
	DOCUMENT_LITERAL,
	DOCUMENT_LITERAL_DOT,
	type DocumentCandidate,
	isPlan,
	isPlanBoundary,
	isPlanHref,
	PLAN_LITERAL_DOT,
	PLAN_NAME,
	protectDocumentReferences,
	resolveDocument,
	restoreDocumentReferences,
} from "../../lib/references";

import {
	CODE_FONT,
	EMOJI_SIZE,
	FONT,
	INLINE_CODE_PADDING,
	LINE_HEIGHT,
	SMALL_CODE_FONT,
	SMALL_EMOJI_SIZE,
	SMALL_FONT,
	SMALL_LINE_HEIGHT,
} from "./constants";

type FontConfig = { font: string; codeFont: string; lineHeight: number; emojiSize: number };

// Timeline text parse/cache version, included in layout.ts parse keys.
const VERSION = 7;
const MENTION_FONT = "600 12px 'Inter Variable', sans-serif";
const MENTION_PAD_START = 1;
const MENTION_PAD_END = 6;
const MENTION_AVATAR = 14;
const MENTION_GAP = 3;
// Avoid shrink-wrapping exactly onto a fractional browser line-break boundary.
const MENTION_WRAP_GUARD = 1;
const DOCUMENT_FONT = MENTION_FONT;
const DOCUMENT_PAD_X = 6;
const DOCUMENT_WRAP_GUARD = 1;
const DEFAULT_FONTS: FontConfig = {
	font: FONT,
	codeFont: CODE_FONT,
	lineHeight: LINE_HEIGHT,
	emojiSize: EMOJI_SIZE,
};
const COMPACT_FONTS: FontConfig = {
	font: SMALL_FONT,
	codeFont: SMALL_CODE_FONT,
	lineHeight: SMALL_LINE_HEIGHT,
	emojiSize: SMALL_EMOJI_SIZE,
};

let parser = createParse({
	autoClose: true,
	html: false,
	plugins: [
		security(),
		highlight({
			languages: [
				bash,
				css,
				html,
				javascript,
				json,
				jsx,
				markdown,
				rust,
				shellscript,
				typescript,
				tsx,
			],
			registerDefaultLanguages: false,
			registerDefaultThemes: false,
			themes: { light: theme },
		}),
		breaks(),
	],
});

type InlineNode =
	| { kind: "text"; text: string; bold?: true; italic?: true; strike?: true; underline?: true }
	| { kind: "code"; text: string }
	| { kind: "link"; text: string; href: string }
	| { kind: "mention"; name: string; avatar?: string }
	| { kind: "document"; uid: string; name: string; reference: string }
	| { kind: "plan"; reference: string }
	| { kind: "emoji"; name: string; src?: string };

type Mention = { name: string; avatar?: string };
type Carrier = Mention & { documents?: readonly DocumentCandidate[] };

type References = {
	avatars: Map<string, string> | null;
	documents: readonly DocumentCandidate[] | undefined;
	plan: boolean;
};

type Line = {
	items: RichInlineItem[];
	prepared: PreparedRichInline | null;
	nodes: InlineNode[];
};

type TableCell = {
	lines: Line[];
	align?: "left" | "center" | "right";
	header: boolean;
};

type TableRow = {
	cells: TableCell[];
};

type ImageNode = {
	src: string;
	alt: string;
};

type BlockNode =
	| { kind: "paragraph"; lines: Line[] }
	| { kind: "heading"; level: number; lines: Line[] }
	| { kind: "list"; ordered: boolean; items: BlockNode[][] }
	| { kind: "blockquote"; children: BlockNode[] }
	| { kind: "table"; rows: TableRow[] }
	| ({ kind: "image" } & ImageNode)
	| { kind: "hr" };

type Segment =
	| { kind: "text"; raw: string; blocks: BlockNode[] }
	| { kind: "code"; source: string; language?: string; nodes?: ComarkNode[] }
	| { kind: "diff"; patch: string };

type Marks = {
	bold: boolean;
	italic: boolean;
	strike: boolean;
	underline: boolean;
	href?: string;
	plan?: boolean;
};

function fonts(compact = false): FontConfig {
	return compact ? COMPACT_FONTS : DEFAULT_FONTS;
}

function font(mark: Marks, base: string): string {
	if (mark.bold && mark.italic) return `italic bold ${base}`;
	if (mark.bold) return `bold ${base}`;
	if (mark.italic) return `italic ${base}`;
	return base;
}

function elem(node: ComarkNode): node is ComarkElement {
	return Array.isArray(node) && typeof node[0] === "string";
}

function kids(node: ComarkElement): ComarkNode[] {
	return node.slice(2) as ComarkNode[];
}

function textof(node: ComarkNode): string {
	if (typeof node === "string") return node;
	if (!elem(node)) return "";
	if (node[0] === "br") return "\n";
	if (node[0] === "img") return typeof node[1].alt === "string" ? node[1].alt : "";
	return kids(node).map(textof).join("");
}

function block(node: ComarkNode): boolean {
	if (!elem(node)) return false;
	return /^(p|h[1-6]|ul|ol|li|blockquote|pre|hr|table|div)$/.test(node[0]);
}

function references(
	mentions?: Mention[],
	documents?: readonly DocumentCandidate[],
	plan = false,
): References {
	let map = new Map<string, string>();
	for (let m of mentions || []) {
		if (m.avatar) map.set(m.name.toLowerCase(), m.avatar);
	}
	return {
		avatars: map.size ? map : null,
		documents: documents
			?? (mentions as Carrier[] | undefined)?.find(mention => mention.documents)?.documents,
		plan,
	};
}

function inline(
	text: string,
	mark: Marks,
	items: RichInlineItem[],
	nodes: InlineNode[],
	refs: References,
	cfg: FontConfig,
	flush: () => void,
	bold = false,
) {
	let re =
		/<\/?u>|(^|[^\S\n]|[([{]|\uFFFC)\\*&[a-z0-9]+(?:-[a-z0-9]+)*(?:\.|\uE001)md|(?<=\n)\\*&[a-z0-9]+(?:-[a-z0-9]+)*(?:\.|\uE001)md|(^|[^\S\n]|[([{]|\uFFFC)plan(?:\.|\uE001)md|(?<=\n)plan(?:\.|\uE001)md|(^|[^\S\n]|[([{]|\uFFFC)@[\w-]+|(?<=\n)@[\w-]+|\n|:[\w+-]+:/gi;
	let last = 0;
	let match;

	// Headings render inside a blanket <strong>; measure their runs bold so wrapped
	// lines match the rendered width and the content box doesn't clip the last line.
	let itemFont = () => font(bold ? { ...mark, bold: true } : mark, cfg.font);

	function push(chunk: string) {
		chunk = restore(chunk);
		if (!chunk) return;
		if (mark.href) {
			items.push({ text: chunk, font: itemFont() });
			nodes.push({ kind: "link", text: chunk, href: mark.href });
			return;
		}
		items.push({ text: chunk, font: itemFont() });
		nodes.push({
			kind: "text",
			text: chunk,
			bold: mark.bold || undefined,
			italic: mark.italic || undefined,
			strike: mark.strike || undefined,
			underline: mark.underline || undefined,
		});
	}
	if (mark.href && !mark.plan && text.toLowerCase().includes(PLAN_NAME)) {
		push(text);
		return;
	}

	while ((match = re.exec(text)) !== null) {
		let tok = match[0]!;
		let lower = tok.toLowerCase();
		let amp = tok.lastIndexOf("&");
		let reference = amp >= 0 ? restore(tok.slice(amp + 1)) : "";
		let plan = amp < 0 ? restore(tok).toLowerCase().lastIndexOf(PLAN_NAME) : -1;
		let end = match.index + tok.length;
		let boundary = isPlanBoundary(text.slice(end));
		let link = !!mark.plan;
		let local = refs.plan && boundary && (
			(isPlan(reference) && !mark.href)
			|| (plan >= 0 && (!mark.href || link))
		);

		if (local) {
			let offset = amp >= 0 ? amp : plan;
			let start = match.index + offset;
			if (start > last) push(text.slice(last, start));
			let source = amp >= 0 ? `&${reference}` : restore(tok.slice(plan, plan + PLAN_NAME.length));
			items.push({
				text: PLAN_NAME,
				font: DOCUMENT_FONT,
				break: "never",
				extraWidth: DOCUMENT_PAD_X * 2 + DOCUMENT_WRAP_GUARD,
			});
			nodes.push({ kind: "plan", reference: source });
			last = match.index + tok.length;
			continue;
		}
		if (plan >= 0 && (!refs.plan || !boundary)) {
			if (match.index > last) push(text.slice(last, match.index));
			push(tok);
			last = end;
			continue;
		}

		let document = reference && !mark.href ? resolveDocument(refs.documents, reference) : undefined;

		if (document) {
			let start = match.index + amp;
			if (start > last) push(text.slice(last, start));
			items.push({
				text: document.name,
				font: DOCUMENT_FONT,
				break: "never",
				extraWidth: DOCUMENT_PAD_X * 2 + DOCUMENT_WRAP_GUARD,
			});
			nodes.push({
				kind: "document",
				uid: document.uid,
				name: document.name,
				reference,
			});
			last = match.index + tok.length;
			continue;
		}

		if (!mark.href && tok.includes("@")) {
			let at = tok.lastIndexOf("@");
			let start = match.index + at;
			if (start > last) push(text.slice(last, start));
			let name = tok.slice(at + 1);
			let avatar = refs.avatars?.get(name.toLowerCase());
			let extra = MENTION_PAD_START + MENTION_PAD_END + MENTION_WRAP_GUARD
				+ (avatar ? MENTION_AVATAR + MENTION_GAP : 0);
			items.push({ text: name, font: MENTION_FONT, break: "never", extraWidth: extra });
			nodes.push({ kind: "mention", name, avatar });
			last = match.index + tok.length;
			continue;
		}

		if (match.index > last) push(text.slice(last, match.index));

		if (tok === "\n") {
			flush();
		} else if (lower === "<u>") {
			mark.underline = true;
		} else if (lower === "</u>") {
			mark.underline = false;
		} else if (mark.href || amp >= 0) {
			push(tok);
		} else {
			let name = tok.slice(1, -1);
			let src = customEmojiSrc(name);
			if (src) {
				items.push({
					text: "⁠",
					font: itemFont(),
					break: "never",
					extraWidth: cfg.emojiSize,
				});
			} else {
				items.push({ text: tok, font: itemFont(), break: "never" });
			}
			nodes.push({ kind: "emoji", name, src });
		}

		last = match.index + tok.length;
	}

	if (last < text.length) push(text.slice(last));
}

function lines(
	nodes: ComarkNode[],
	refs: References,
	cfg: FontConfig,
	bold = false,
): Line[] {
	let out: Line[] = [];
	let items: RichInlineItem[] = [];
	let ns: InlineNode[] = [];
	let root: Marks = { bold: false, italic: false, strike: false, underline: false };

	function flush() {
		out.push({ items, prepared: items.length > 0 ? prepareRichInline(items) : null, nodes: ns });
		items = [];
		ns = [];
	}

	function shortcode(list: ComarkNode[], index: number, mark: Marks): boolean {
		let node = list[index];
		let next = list[index + 1];
		if (!node || !elem(node) || kids(node).length || typeof next !== "string") return false;
		if (!next.startsWith(":")) return false;
		inline(`:${node[0]}:`, mark, items, ns, refs, cfg, flush, bold);
		list[index + 1] = next.slice(1);
		return true;
	}

	function walk(node: ComarkNode, mark: Marks) {
		if (typeof node === "string") {
			inline(node, mark, items, ns, refs, cfg, flush, bold);
			return;
		}
		if (!elem(node)) return;

		let tag = node[0];
		if (tag === "br") {
			flush();
			return;
		}
		if (tag === "code") {
			let text = textof(node);
			items.push({
				text,
				font: bold ? `bold ${cfg.codeFont}` : cfg.codeFont,
				break: "never",
				extraWidth: INLINE_CODE_PADDING * 2,
			});
			ns.push({ kind: "code", text });
			return;
		}
		if (tag === "img") {
			let alt = typeof node[1].alt === "string" ? node[1].alt : "";
			if (alt || mark.href) {
				inline(alt || "Open image", mark, items, ns, refs, cfg, flush, bold);
			}
			return;
		}

		let next = { ...mark };
		if (tag === "strong" || tag === "b") next.bold = true;
		else if (tag === "em" || tag === "i") next.italic = true;
		else if (tag === "del" || tag === "s" || tag === "strike") next.strike = true;
		else if (tag === "u") next.underline = true;
		else if (tag === "a") {
			next.href = typeof node[1].href === "string" ? node[1].href : undefined;
			next.plan = !!next.href && isPlanHref(next.href) && isPlan(textof(node));
		}

		let children = kids(node);
		for (let i = 0; i < children.length; i++) {
			if (!shortcode(children, i, next)) walk(children[i]!, next);
		}
	}

	for (let i = 0; i < nodes.length; i++) {
		if (!shortcode(nodes, i, root)) walk(nodes[i]!, root);
	}
	flush();
	return out;
}

function convert(
	node: ComarkElement,
	refs: References,
	cfg: FontConfig,
): BlockNode[] {
	let tag = node[0];
	if (tag === "p") {
		let img = image(node);
		if (img) return [{ kind: "image", ...img }];
		return [{ kind: "paragraph", lines: lines(kids(node), refs, cfg) }];
	}
	if (/^h[1-6]$/.test(tag)) {
		return [{
			kind: "heading",
			level: Number(tag.slice(1)),
			lines: lines(kids(node), refs, cfg, true),
		}];
	}
	if (tag === "ul" || tag === "ol") {
		let items: BlockNode[][] = [];
		for (let child of kids(node)) {
			if (elem(child) && child[0] === "li") items.push(blocks(kids(child), refs, cfg));
		}
		return [{ kind: "list", ordered: tag === "ol", items }];
	}
	if (tag === "blockquote") {
		return [{ kind: "blockquote", children: blocks(kids(node), refs, cfg) }];
	}
	if (tag === "table") return [{ kind: "table", rows: table(node, refs, cfg) }];
	if (tag === "hr") return [{ kind: "hr" }];
	if (tag === "pre") return [];
	return [{ kind: "paragraph", lines: lines(kids(node), refs, cfg) }];
}

function image(node: ComarkElement): ImageNode | null {
	let children = kids(node).filter(child => typeof child !== "string" || child.trim());
	if (children.length !== 1) return null;

	let child = children[0];
	if (!elem(child)) return null;
	if (child[0] === "img") return imageNode(child);
	return null;
}

function imageRun(nodes: ComarkNode[]): ImageNode | null {
	let children = nodes.filter(child => typeof child !== "string" || child.trim());
	if (children.length !== 1) return null;
	let child = children[0];
	return elem(child) && child[0] === "img" ? imageNode(child) : null;
}

function imageNode(node: ComarkElement): ImageNode | null {
	let src = typeof node[1].src === "string" ? node[1].src : "";
	if (!src) return null;
	let alt = typeof node[1].alt === "string" ? node[1].alt : "";
	return { src, alt };
}

function align(node: ComarkElement): TableCell["align"] {
	let style = typeof node[1].style === "string" ? node[1].style : "";
	if (style.includes("right")) return "right";
	if (style.includes("center")) return "center";
	return undefined;
}

function row(node: ComarkElement, refs: References, cfg: FontConfig): TableRow {
	let cells: TableCell[] = [];
	for (let child of kids(node)) {
		if (elem(child) && (child[0] === "td" || child[0] === "th")) {
			cells.push({
				lines: lines(kids(child), refs, cfg),
				align: align(child),
				header: child[0] === "th",
			});
		}
	}
	return { cells };
}

function table(node: ComarkElement, refs: References, cfg: FontConfig): TableRow[] {
	let rows: TableRow[] = [];
	function walk(node: ComarkElement) {
		if (node[0] === "tr") rows.push(row(node, refs, cfg));
		else for (let child of kids(node)) if (elem(child)) walk(child);
	}
	walk(node);
	return rows;
}

function blocks(
	nodes: ComarkNode[],
	refs: References,
	cfg: FontConfig,
): BlockNode[] {
	let out: BlockNode[] = [];
	let run: ComarkNode[] = [];

	function flush() {
		if (!run.length) return;
		let img = imageRun(run);
		if (img) {
			out.push({ kind: "image", ...img });
		} else if (textof(["span", {}, ...run]).trim()) {
			out.push({ kind: "paragraph", lines: lines(run, refs, cfg) });
		}
		run = [];
	}

	for (let node of nodes) {
		if (block(node)) {
			flush();
			if (elem(node)) out.push(...convert(node, refs, cfg));
		} else {
			run.push(node);
		}
	}

	flush();
	return out;
}

const CODE = /```[\s\S]*?(?:```|$)|(`+)[\s\S]*?\1/g;
const DOCUMENT = /&([a-z0-9]+(?:-[a-z0-9]+)*\.md)/gi;
const DOCUMENT_LINK = /(^|[\s([{])(\\*)&([a-z0-9]+(?:-[a-z0-9]+)*\.md)/gi;
const MARKDOWN_LINK = /\[([^\]\n]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
const PLAN_LINK = /(^|[\s([{])(plan\.md)/gi;

function restore(text: string): string {
	return restoreDocumentReferences(text)
		.replaceAll(DOCUMENT_LITERAL_DOT, ".")
		.replaceAll(PLAN_LITERAL_DOT, ".");
}

function encode(text: string, plan: boolean): string {
	let value = text.replace(
		DOCUMENT_LINK,
		(_match, prefix: string, slashes: string, name: string) =>
			prefix + slashes + "&" + name.replace(/\.md$/i, `${DOCUMENT_LITERAL_DOT}md`),
	);
	if (!plan) return value;
	return value.replace(
		PLAN_LINK,
		(match, prefix: string, name: string, offset: number, input: string) => {
			if (isPlanBoundary(input.slice(offset + match.length))) return match;
			return prefix + name.slice(0, -3) + PLAN_LITERAL_DOT + name.slice(-2);
		},
	);
}

function protectPlanLinks(text: string): string {
	return text.replace(
		MARKDOWN_LINK,
		(value, label: string, href: string) =>
			isPlanHref(href) && isPlan(label.trim())
				? value
				: value.replace(
					/plan\.md/gi,
					name => name.slice(0, -3) + PLAN_LITERAL_DOT + name.slice(-2),
				),
	);
}

function protectLinks(text: string, plan: boolean): string {
	let out = "";
	let last = 0;
	let match: RegExpExecArray | null;
	CODE.lastIndex = 0;
	while (match = CODE.exec(text)) {
		out += encode(text.slice(last, match.index), plan);
		out += match[0];
		last = match.index + match[0].length;
	}
	return out + encode(text.slice(last), plan);
}

function collapse(text: string): string {
	return text.replace(/(\\+)(?=&|\uE000)/g, slashes => "\\".repeat(slashes.length / 2));
}

function protectCode(text: string): string {
	let out = "";
	let last = 0;
	let match: RegExpExecArray | null;
	CODE.lastIndex = 0;
	while (match = CODE.exec(text)) {
		out += collapse(text.slice(last, match.index));
		out += match[0]
			.replace(
				DOCUMENT,
				(_match, name: string) =>
					DOCUMENT_LITERAL + name.replace(/\.md$/i, `${DOCUMENT_LITERAL_DOT}md`),
			)
			.replace(/plan\.md/gi, value => value.slice(0, -3) + PLAN_LITERAL_DOT + value.slice(-2));
		last = match.index + match[0].length;
	}
	return out + collapse(text.slice(last));
}

function fallback(
	raw: string,
	mentions?: Mention[],
	cfg: FontConfig = DEFAULT_FONTS,
	plan = false,
): BlockNode[] {
	let value = protectPlanLinks(protectCode(protectDocumentReferences(raw)));
	return blocks([value], references(mentions, undefined, plan), cfg);
}

async function parseSegments(
	raw: string,
	mentions?: Mention[],
	cfg: FontConfig = DEFAULT_FONTS,
	streaming = false,
	documents?: readonly DocumentCandidate[],
	plan = false,
): Promise<Segment[]> {
	let value = protectLinks(protectDocumentReferences(raw), plan);
	let tree = await parser(value, { streaming });
	let out: Segment[] = [];
	let refs = references(mentions, documents, plan);
	let run: ComarkNode[] = [];

	function flush() {
		let prose = blocks(run, refs, cfg);
		let value = restore(textof(["span", {}, ...run])).trim();
		if (prose.length && (value || prose.some(block => block.kind === "image"))) {
			out.push({ kind: "text", raw: value, blocks: prose });
		}
		run = [];
	}

	for (let node of tree.nodes) {
		if (elem(node) && node[0] === "pre") {
			flush();
			let code = kids(node).find(elem);
			let source = textof(code || node);
			if (!source.trim()) continue;
			let language = typeof node[1].language === "string" ? node[1].language : undefined;
			if (language === "diff") out.push({ kind: "diff", patch: source });
			else out.push({ kind: "code", source, language, nodes: code ? kids(code) : kids(node) });
		} else {
			run.push(node);
		}
	}

	flush();
	return out;
}

export { fallback, fonts, parseSegments, VERSION };
export type {
	BlockNode,
	FontConfig,
	ImageNode,
	InlineNode,
	Line,
	Mention,
	Segment,
	TableCell,
	TableRow,
};
