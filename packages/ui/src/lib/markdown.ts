import MarkdownIt from "markdown-it";
import {
	defaultMarkdownParser,
	defaultMarkdownSerializer,
	MarkdownParser,
	MarkdownSerializer,
} from "prosemirror-markdown";
import type { Node as PMNode } from "prosemirror-model";
import type Token from "markdown-it/lib/token.mjs";

import { customEmojiSrc } from "./emoji";

import { schema } from "../components/rich-text/schema";
import {
	DOCUMENT_LITERAL_DOT,
	type DocumentCandidate,
	isPlan,
	isPlanBoundary,
	isPlanHref,
	PLAN_LITERAL_DOT,
	protectDocumentReferences,
	resolveDocument,
	restoreDocumentReferences,
} from "../components/rich-text/references";
import type { Mention } from "../components/rich-text/rich-text";

const LINE_START = /^\s*(?:[-+>=#]|\d+\.)/;

/**
 * Markdown serializer for the rich-text schema. Extends the default ProseMirror
 * markdown serializer with our custom mention/emoji nodes and strike/underline
 * marks. The wire format is designed to roundtrip through `blocks/parse.ts`:
 *
 * - `mention` → `@name`
 * - `document` → `&name.md`
 * - `plan` → `&plan.md`
 * - `emoji` → `:name:`
 * - `strike` → `~~text~~`
 * - `underline` → `<u>text</u>` (HTML escape hatch — markdown has no native underline)
 */
const serializer = new MarkdownSerializer(
	{
		...defaultMarkdownSerializer.nodes,
		mention(state, node, parent, index) {
			state.write(`@${node.attrs.name}`);
			// Guard against the mention gluing onto following text: "@ace" + "can"
			// serializes to "@acecan", which re-parses as a single mention named
			// "acecan" and silently drops the Ace invocation. Insert a separating
			// space when the next inline node would extend the mention token.
			let next = index + 1 < parent.childCount ? parent.child(index + 1) : null;
			if (next?.isText && /^[\w-]/.test(next.text ?? "")) state.write(" ");
		},
		document(state, node, parent, index) {
			state.write(`&${node.attrs.name}`);
			let next = index + 1 < parent.childCount ? parent.child(index + 1) : null;
			if (next?.isText && /^[\w-]/.test(next.text ?? "")) state.write(" ");
		},
		plan(state, _node, parent, index) {
			state.write("&plan.md");
			let next = index + 1 < parent.childCount ? parent.child(index + 1) : null;
			if (next?.isText && /^[\w-]/.test(next.text ?? "")) state.write(" ");
		},
		emoji(state, node) {
			state.write(`:${node.attrs.name}:`);
		},
		text(state, node, parent, index) {
			// A line after a hard break can open a list, quote, or heading that interrupts the
			// paragraph, which strands the break's trailing backslash as literal text.
			let text = node.text!;
			let broken = index > 0 && parent.child(index - 1).type === schema.nodes.hard_break;
			if (!broken || !LINE_START.test(text)) {
				return defaultMarkdownSerializer.nodes.text!(state, node, parent, index);
			}
			state.text(state.esc(text, true).replace(/^(\s*)=/, "$1\\="), false);
		},
	},
	{
		...defaultMarkdownSerializer.marks,
		strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
		underline: { open: "<u>", close: "</u>", mixable: true, expelEnclosingWhitespace: true },
	},
	{ escapeExtraCharacters: /&(?=[a-z0-9]+(?:-[a-z0-9]+)*\.md\b)/gi },
);

let tokenizer = new MarkdownIt({ html: true, linkify: true, breaks: true });
let parser = new MarkdownParser(schema, {
	...tokenizer,
	parse(text, env) {
		let tokens = tokenizer.parse(text, env);
		normalize(tokens);
		return tokens;
	},
} as MarkdownIt, {
	...defaultMarkdownParser.tokens,
	html_block: { block: "paragraph", noCloseToken: true },
	softbreak: { node: "hard_break" },
	s: { mark: "strike" },
	u: { mark: "underline" },
});

const DOCUMENT_NAME = "[a-z0-9]+(?:-[a-z0-9]+)*\\.md";
const CODE_OR_REFERENCE = new RegExp(
	`\`\`\`[\\s\\S]*?(?:\`\`\`|$)|(\`+)[\\s\\S]*?\\1|(^|[\\s([{])((?:\\\\)*)&(${DOCUMENT_NAME})|(^|[\\s([{])(plan\\.md)`,
	"gi",
);

/** Serialize a ProseMirror doc to markdown, trimmed. */
function serialize(doc: PMNode): string {
	return serializer.serialize(doc).trim();
}

function normalize(tokens: Token[]) {
	for (let token of tokens) {
		if (token.children) normalize(token.children);
		if (token.type !== "html_inline") continue;

		let html = token.content.toLowerCase().trim();
		if (html === "<u>") token.type = "u_open";
		else if (html === "</u>") token.type = "u_close";
		else token.type = "text";
	}
}

function protectLinks(text: string, plan: boolean): string {
	return text.replace(
		CODE_OR_REFERENCE,
		(
			match,
			_ticks: string,
			prefix: string,
			slashes: string,
			name: string,
			planPrefix: string,
			planName: string,
			offset: number,
			input: string,
		) => {
			if (name) {
				return prefix + slashes + "&"
					+ name.replace(/\.md$/i, `${DOCUMENT_LITERAL_DOT}md`);
			}
			if (!plan || !planName) return match;
			let dot = isPlanBoundary(input.slice(offset + match.length))
				? DOCUMENT_LITERAL_DOT
				: PLAN_LITERAL_DOT;
			return planPrefix + planName.slice(0, -3) + dot + planName.slice(-2);
		},
	);
}

function restore(text: string): string {
	return restoreDocumentReferences(text)
		.replaceAll(DOCUMENT_LITERAL_DOT, ".")
		.replaceAll(PLAN_LITERAL_DOT, ".");
}

function inline(
	text: string,
	marks: PMNode["marks"],
	mentions?: Map<string, Mention>,
	documents?: readonly DocumentCandidate[],
	plan = false,
): PMNode[] {
	let link = schema.marks.link.isInSet(marks);
	if (link) {
		if (plan && isPlan(restore(text)) && isPlanHref(link.attrs.href)) {
			return [schema.nodes.plan.create()];
		}
		return [schema.text(restore(text), marks)];
	}

	let out: PMNode[] = [];
	let re =
		/(^|[\s([{\uFFFC])(\\*)&([a-z0-9]+(?:-[a-z0-9]+)*(?:\.|\uE001)md)|(^|[\s([{\uFFFC])(plan(?:\.|\uE001)md)|(^|[\s([{\uFFFC])@([A-Za-z0-9-]+)|:([\w+-]+):/gi;
	let last = 0;
	let match;

	function push(start: number, end: number) {
		if (end > start) {
			out.push(schema.text(restore(text.slice(start, end)), marks));
		}
	}

	while ((match = re.exec(text)) !== null) {
		if (match[3]) {
			let name = restore(match[3]);
			let start = match.index + match[1]!.length + match[2]!.length;
			let end = start + match[3].length + 1;
			if (plan && isPlan(name) && isPlanBoundary(text.slice(end))) {
				push(last, start);
				out.push(schema.nodes.plan.create());
				last = end;
				continue;
			}
			let document = resolveDocument(documents, name);
			if (!document) continue;
			push(last, start);
			out.push(schema.node("document", { uid: document.uid, name: document.name }));
			last = end;
			continue;
		}

		if (match[5]) {
			if (!plan) continue;
			let start = match.index + match[4]!.length;
			let end = start + match[5].length;
			if (!isPlanBoundary(text.slice(end))) continue;
			push(last, start);
			out.push(schema.nodes.plan.create());
			last = end;
			continue;
		}

		if (match[7]) {
			let name = match[7];
			let entry = mentions?.get(name);
			if (!entry) continue;
			let start = match.index + match[6]!.length;
			let end = start + name.length + 1;
			push(last, start);
			out.push(schema.node("mention", {
				id: entry.id ?? null,
				name: entry.name,
				avatar: entry.avatar ?? null,
			}));
			last = end;
			continue;
		}

		let name = match[8]!;
		let src = customEmojiSrc(name);
		if (!src) continue;
		push(last, match.index);
		out.push(schema.node("emoji", { id: name, name, src }));
		last = match.index + match[0]!.length;
	}

	push(last, text.length);
	return out;
}

function expand(
	node: PMNode,
	mentions?: Map<string, Mention>,
	documents?: readonly DocumentCandidate[],
	plan = false,
): PMNode[] {
	if (node.type === schema.nodes.code_block) return [node];
	if (node.isText) {
		if (!node.text || schema.marks.code.isInSet(node.marks)) return [node];
		return inline(node.text, node.marks, mentions, documents, plan);
	}

	if (node.isLeaf) return [node];

	let children: PMNode[] = [];
	node.forEach(child => {
		children.push(...expand(child, mentions, documents, plan));
	});
	return [node.type.create(node.attrs, children, node.marks)];
}

function enrich(
	doc: PMNode,
	mentions?: Mention[],
	documents?: readonly DocumentCandidate[],
	plan = false,
): PMNode {
	let map = mentions?.length ? new Map(mentions.map(item => [item.name, item])) : undefined;
	return expand(doc, map, documents, plan)[0]!;
}

/** Parse stored markdown into the rich-text editor schema. */
function parse(
	raw = "",
	mentions?: Mention[],
	documents?: readonly DocumentCandidate[],
	plan = false,
): PMNode {
	let text = protectLinks(protectDocumentReferences(raw), plan);
	return enrich(parser.parse(text), mentions, documents, plan);
}

export { parse, serialize, serializer };
