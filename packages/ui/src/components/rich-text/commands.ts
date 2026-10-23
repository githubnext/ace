import { lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { InputRule, wrappingInputRule } from "prosemirror-inputrules";
import { type EditorState, TextSelection } from "prosemirror-state";
import { liftListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { schema } from "./schema";

function has(state: EditorState, type: typeof schema.nodes.paragraph | typeof schema.marks.em) {
	let { $from } = state.selection;
	for (let d = $from.depth; d > 0; d--) {
		if ($from.node(d).type === type) return true;
	}
	return false;
}

const toggleBold = toggleMark(schema.marks.strong);
const toggleItalic = toggleMark(schema.marks.em);
const toggleUnderline = toggleMark(schema.marks.underline);
const toggleStrike = toggleMark(schema.marks.strike);
const toggleCode = toggleMark(schema.marks.code);

function normalize(href: string) {
	let value = href.trim();
	if (!value) return "";
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
	return `https://${value}`;
}

function findLink(state: EditorState) {
	let type = schema.marks.link;
	if (!type) return null;

	let { from, to, empty } = state.selection;
	if (empty) {
		let { $from } = state.selection;
		let parent = $from.parent;
		let base = $from.start();
		let pos = $from.parentOffset;
		let off = 0;

		for (let i = 0; i < parent.childCount; i++) {
			let node = parent.child(i);
			let next = off + node.nodeSize;
			let edge = node.isText && (pos === off || pos === next);
			let inside = pos > off && pos < next;
			if (!edge && !inside) {
				off = next;
				continue;
			}

			let mark = node.isText ? type.isInSet(node.marks) : null;
			if (!mark) {
				off = next;
				continue;
			}

			let start = off;
			let end = next;

			for (let j = i - 1, at = off; j >= 0; j--) {
				let prev = parent.child(j);
				at -= prev.nodeSize;
				if (!prev.isText) break;
				let prevMark = type.isInSet(prev.marks);
				if (!prevMark || prevMark.attrs.href !== mark.attrs.href) break;
				start = at;
			}

			for (let j = i + 1, at = next; j < parent.childCount; j++) {
				let nextNode = parent.child(j);
				if (!nextNode.isText) break;
				let nextMark = type.isInSet(nextNode.marks);
				if (!nextMark || nextMark.attrs.href !== mark.attrs.href) break;
				end = at + nextNode.nodeSize;
				at = end;
			}

			return { from: base + start, to: base + end, href: mark.attrs.href || "" };
		}

		return null;
	}

	let found: { from: number; to: number; href: string } | null = null;
	state.doc.nodesBetween(from, to, (node) => {
		if (!node.isText || found) return;
		let mark = type.isInSet(node.marks);
		if (mark) found = { from, to, href: mark.attrs.href || "" };
	});
	return found;
}

function getLink(state: EditorState) {
	return findLink(state)?.href || null;
}

function getLinkInfo(state: EditorState) {
	let range = findLink(state);
	if (!range) return null;
	return {
		...range,
		text: state.doc.textBetween(range.from, range.to, " "),
	};
}

function setLink(href: string, label?: string) {
	return (state: EditorState, dispatch?: (tr: typeof state.tr) => void) => {
		let type = schema.marks.link;
		if (!type) return false;
		let value = normalize(href);
		if (!value) return false;
		let text = label?.trim() || "";
		let mark = type.create({ href: value, title: null });

		let { from, to, empty } = state.selection;
		if (!dispatch) return true;
		let range = empty ? findLink(state) : { from, to };
		if (range) {
			let current = state.doc.textBetween(range.from, range.to, " ");
			if (text && text !== current) {
				let tr = state.tr.replaceWith(range.from, range.to, schema.text(text, [mark]));
				dispatch(
					tr.setSelection(TextSelection.create(tr.doc, range.from + text.length)).removeStoredMark(
						type,
					),
				);
				return true;
			}
			dispatch(state.tr.removeMark(range.from, range.to, type).addMark(range.from, range.to, mark));
			return true;
		}

		let next = text || value;
		let tr = state.tr.insertText(next, from, to);
		tr = tr
			.addMark(from, from + next.length, mark)
			.setSelection(TextSelection.create(tr.doc, from + next.length))
			.removeStoredMark(type);
		dispatch(tr);
		return true;
	};
}

function clearLink(state: EditorState, dispatch?: (tr: typeof state.tr) => void) {
	let type = schema.marks.link;
	if (!type) return false;

	let { from, to, empty } = state.selection;
	if (empty) {
		let range = findLink(state);
		if (!range) return false;
		from = range.from;
		to = range.to;
	}

	if (!dispatch) return true;
	dispatch(state.tr.removeMark(from, to, type));
	return true;
}

function toggleBullet() {
	let type = schema.nodes.bullet_list;
	let item = schema.nodes.list_item;

	return (state: EditorState, dispatch?: (tr: typeof state.tr) => void) => {
		if (has(state, type)) return liftListItem(item)(state, dispatch);
		return wrapInList(type)(state, dispatch);
	};
}

function toggleOrdered() {
	let type = schema.nodes.ordered_list;
	let item = schema.nodes.list_item;

	return (state: EditorState, dispatch?: (tr: typeof state.tr) => void) => {
		if (has(state, type)) return liftListItem(item)(state, dispatch);
		return wrapInList(type)(state, dispatch);
	};
}

/** A new line in a list item starts the next item; on an empty item it leaves the list. */
function splitList(state: EditorState, dispatch?: (tr: typeof state.tr) => void) {
	let item = schema.nodes.list_item;
	let { $from, empty } = state.selection;
	if (!empty || $from.node(-1).type !== item) return false;
	if (!$from.parent.content.size) return liftListItem(item)(state, dispatch);
	return splitListItem(item)(state, dispatch);
}

function toggleQuote(state: EditorState, dispatch?: (tr: typeof state.tr) => void) {
	let type = schema.nodes.blockquote;
	if (has(state, type)) return lift(state, dispatch);
	return wrapIn(type)(state, dispatch);
}

function toggleCodeBlock(state: EditorState, dispatch?: (tr: typeof state.tr) => void) {
	if (state.selection.$from.parent.type === schema.nodes.code_block) {
		return setBlockType(schema.nodes.paragraph)(state, dispatch);
	}
	return setBlockType(schema.nodes.code_block, { params: "" })(state, dispatch);
}

/** Input rule: typing ```lang converts the paragraph into a code block. */
function codeBlockRule() {
	return new InputRule(/^```(\w*)$/, (state, match, start, end) => {
		let params = match[1] || "";
		let $start = state.doc.resolve(start);
		if (
			!$start.node(-1).canReplaceWith(
				$start.index(-1),
				$start.indexAfter(-1),
				schema.nodes.code_block,
			)
		) return null;
		return state.tr
			.delete(start, end)
			.setBlockType(start, start, schema.nodes.code_block, { params });
	});
}

/**
 * `**bold**` or `~~strike~~` as its closing marker's last character is typed, which the rule
 * replaces; as in Markdown, the text can't start or end with a space.
 */
function pairRule(marker: "*" | "~", mark: typeof schema.marks.strong) {
	let m = `\\${marker}`;
	let pattern = new RegExp(`(?:^|[^${m}])(${m}${m}([^${m}\\s](?:[^${m}]*[^${m}\\s])?)${m}${m})$`);
	return new InputRule(pattern, (state, match, start, end) => {
		let from = start + match[0]!.length - match[1]!.length;
		return state.tr
			.delete(end - 1, end)
			.delete(from, from + 2)
			.addMark(from, end - 3, mark.create())
			.removeStoredMark(mark);
	}, { inCodeMark: false });
}

/** Input rules for the Markdown markers people type, as in Slack or Notion. */
function markdownRules() {
	return [
		wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list),
		wrappingInputRule(
			/^(\d+)\.\s$/,
			schema.nodes.ordered_list,
			(match) => ({ order: +match[1]! }),
			(match, node) => node.childCount + node.attrs.order === +match[1]!,
		),
		// U+FFFC stands in for mentions and emoji, which inline code can't hold.
		new InputRule(/(?:^|[^`])(`([^`\ufffc]+)`)$/, (state, match, start, end) => {
			let from = start + match[0]!.length - match[1]!.length;
			let code = schema.marks.code;
			return state.tr
				.delete(from, from + 1)
				.addMark(from, end - 1, code.create())
				.removeStoredMark(code);
		}, { inCodeMark: false }),
		pairRule("*", schema.marks.strong),
		pairRule("~", schema.marks.strike),
	];
}

/** Exit code block: Cmd+Enter creates a paragraph after and moves cursor there. */
function exitCodeBlock(state: EditorState, dispatch?: (tr: typeof state.tr) => void) {
	let { $head } = state.selection;
	if ($head.parent.type !== schema.nodes.code_block) return false;
	if (!dispatch) return true;

	let pos = $head.after();
	let tr = state.tr.insert(pos, schema.nodes.paragraph.createAndFill()!);
	tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
	dispatch(tr);
	return true;
}

/** Backspace at start of empty code block converts it back to a paragraph. */
function backspaceCodeBlock(state: EditorState, dispatch?: (tr: typeof state.tr) => void) {
	let { $head, empty } = state.selection;
	if (!empty || $head.parent.type !== schema.nodes.code_block) return false;
	if ($head.parentOffset > 0 || $head.parent.content.size > 0) return false;
	if (!dispatch) return true;

	let from = $head.start() - 1;
	let to = $head.end() + 1;
	dispatch(state.tr.replaceWith(from, to, schema.nodes.paragraph.create()));
	return true;
}

export {
	backspaceCodeBlock,
	clearLink,
	codeBlockRule,
	exitCodeBlock,
	getLink,
	getLinkInfo,
	markdownRules,
	setLink,
	splitList,
	toggleBold,
	toggleBullet,
	toggleCode,
	toggleCodeBlock,
	toggleItalic,
	toggleOrdered,
	toggleQuote,
	toggleStrike,
	toggleUnderline,
};
