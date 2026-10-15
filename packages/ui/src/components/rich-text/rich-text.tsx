import {
	type ComponentPropsWithRef,
	type Ref,
	useEffect,
	useEffectEvent,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Fragment, type Mark, type Node, Slice } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, chainCommands, exitCode, newlineInCode } from "prosemirror-commands";
import { inputRules } from "prosemirror-inputrules";
import { createHighlightPlugin } from "prosemirror-highlight";
import { createParser } from "prosemirror-highlight/shiki";
import { SearchIndex } from "emoji-mart";
import { initEmoji } from "../../lib/emoji";
import { getHighlighter } from "../../lib/highlighter";
import { cn, isUrl } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverPortal, PopoverPositioner } from "../../ui/popover";

import { schema } from "./schema";
import {
	backspaceCodeBlock,
	codeBlockRule,
	exitCodeBlock,
	setLink,
	toggleBold,
	toggleBullet,
	toggleCode,
	toggleCodeBlock,
	toggleItalic,
	toggleOrdered,
	toggleQuote,
	toggleStrike,
	toggleUnderline,
} from "./commands";
import {
	documentPlugin,
	emojiPlugin,
	insertCustomEmoji,
	insertDocument,
	insertEmoji,
	insertMention,
	insertPlan,
	type Mention,
	placeholderPlugin,
	slashPlugin,
	suggestPlugin,
	type SuggestState,
} from "./plugins";
import {
	type DocumentCandidate,
	isPlan,
	isPlanBoundary,
	PLAN_NAME,
	resolveDocument,
} from "./references";
import "./rich-text.css";

/** A slash command entry for the `/` menu. */
type SlashCommand = {
	name: string;
	description?: string;
	icon?: string;
	action: (view: EditorView, range?: { from: number; to: number }) => void;
};

type PopupItem = {
	key: string;
	label: string;
	avatar?: string;
	icon?: string;
	description?: string;
	action: (view: EditorView) => void;
};

type Popup = {
	source: "document" | "emoji" | "mention" | "slash";
	items: PopupItem[];
	index: number;
	anchor: { getBoundingClientRect: () => DOMRect };
};

/** No mouse or trackpad: a phone, or a tablet without a keyboard case. */
function touchOnly() {
	return !matchMedia("(any-pointer: fine)").matches;
}

function getAnchor(view: EditorView, pos: number) {
	let box = view.coordsAtPos(pos);
	return {
		getBoundingClientRect: () =>
			new DOMRect(box.left, box.top, box.right - box.left, box.bottom - box.top),
	};
}

function getPaste(e: ClipboardEvent) {
	let uri = e.clipboardData?.getData("text/uri-list");
	if (uri) {
		let value = uri
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line && !line.startsWith("#"));
		if (value) return value;
	}

	let text = e.clipboardData?.getData("text/plain")?.trim();
	return text || "";
}

function getFiles(e: ClipboardEvent) {
	let data = e.clipboardData;
	// Spreadsheet and document copies carry a rendered image beside their text; paste the text.
	if (!data || data.types.includes("text/plain")) return [];
	return Array.from(data.files);
}

function inline(
	text: string,
	marks: readonly Mark[],
	mentions: Map<string, Mention>,
	documents?: readonly DocumentCandidate[],
	plan = false,
) {
	let out: Node[] = [];
	let re = /(^|\s)@([\w.-]+)|(^|[\s([{])&([a-z0-9]+(?:-[a-z0-9]+)*\.md)|(^|[\s([{])(plan\.md)/gi;
	let last = 0;
	let match;

	function push(from: number, to: number) {
		if (to > from) out.push(schema.text(text.slice(from, to), marks));
	}

	while ((match = re.exec(text)) !== null) {
		if (match[4]) {
			if (schema.marks.link.isInSet(marks)) continue;
			let from = match.index + match[3]!.length;
			let to = from + match[4].length + 1;
			if (plan && isPlan(match[4]) && isPlanBoundary(text.slice(to))) {
				push(last, from);
				out.push(schema.nodes.plan.create());
				last = to;
				continue;
			}
			let document = resolveDocument(documents, match[4]);
			if (!document) continue;
			push(last, from);
			out.push(schema.nodes.document.create({ uid: document.uid, name: document.name }));
			last = to;
			continue;
		}

		if (match[6]) {
			if (!plan || schema.marks.link.isInSet(marks)) continue;
			let from = match.index + match[5]!.length;
			let to = from + match[6].length;
			if (!isPlanBoundary(text.slice(to))) continue;
			push(last, from);
			out.push(schema.nodes.plan.create());
			last = to;
			continue;
		}

		let name = match[2]!;
		let item = mentions.get(name.toLowerCase());
		if (!item) continue;

		let from = match.index + match[1]!.length;
		let to = from + name.length + 1;
		push(last, from);
		out.push(schema.nodes.mention.create({
			id: item.id ?? null,
			name: item.name,
			avatar: item.avatar ?? null,
		}));
		last = to;
	}

	if (!out.length) return null;
	push(last, text.length);
	return out;
}

function fragment(
	data: Fragment,
	mentions: Map<string, Mention>,
	documents?: readonly DocumentCandidate[],
	plan = false,
) {
	let out: Node[] = [];
	let changed = false;

	data.forEach(node => {
		if (node.type === schema.nodes.code_block) {
			out.push(node);
			return;
		}

		if (node.isText) {
			let nodes = node.text && !schema.marks.code.isInSet(node.marks)
				? inline(node.text, node.marks, mentions, documents, plan)
				: null;
			out.push(...(nodes || [node]));
			changed ||= !!nodes;
			return;
		}

		if (node.isLeaf) {
			out.push(node);
			return;
		}

		let next = fragment(node.content, mentions, documents, plan);
		out.push(next === node.content ? node : node.copy(next));
		changed ||= next !== node.content;
	});

	return changed ? Fragment.fromArray(out) : data;
}

function pasted(
	slice: Slice,
	list?: Mention[],
	documents?: readonly DocumentCandidate[],
	plan = false,
) {
	if (!list?.length && !documents?.length && !plan) return slice;
	let mentions = new Map(list?.map(item => [item.name.toLowerCase(), item]) || []);
	let content = fragment(slice.content, mentions, documents, plan);
	return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}

type Props =
	& Omit<
		ComponentPropsWithRef<"div">,
		"defaultValue" | "onChange" | "onKeyDown" | "onSubmit" | "ref"
	>
	& {
		/** Ref to the ProseMirror EditorView for toolbar integration. */
		ref?: Ref<EditorView | null>;
		/** Called on every document change. */
		onChange?: (view: EditorView) => void;
		/** Called on every state update, including selection changes. */
		onUpdate?: (view: EditorView) => void;
		/** Called before internal key handling. Return true to consume the event. */
		onKeyDown?: (view: EditorView, event: KeyboardEvent) => boolean;
		/** Called on Enter (without Shift). Use for send. */
		onSubmit?: (view: EditorView) => void;
		/** Called when the editor wants the parent to edit a link. */
		onLink?: (anchor: { getBoundingClientRect: () => DOMRect }) => void;
		/** Called when the mention suggestion state changes. */
		onSuggest?: (state: SuggestState) => void;
		/** Called when a mention is inserted (via autocomplete or popup). */
		onMention?: (name: string) => void;
		/** Receives pasted files. If omitted, pasted files are ignored. */
		onFiles?: (files: File[]) => void;
		/** Users for @mention autocomplete. */
		mentions?: Mention[];
		/** Documents for &name.md autocomplete and pasted-reference enrichment. */
		documents?: readonly DocumentCandidate[];
		/** Enables the reserved Plan reference in & autocomplete and pasted text. */
		plan?: boolean;
		/** Slash commands for the `/` menu. If omitted, slash menu is disabled. */
		commands?: SlashCommand[];
		/** Placeholder shown when the editor is empty. */
		placeholder?: string;
		/** Initial document content as ProseMirror Node JSON. */
		defaultValue?: Record<string, unknown>;
	};

/**
 * Rich text editor built on ProseMirror.
 *
 * Supports semantic rich text formatting plus mentions and slash commands.
 */
function useEditor(
	{
		ref,
		onChange,
		onUpdate,
		onKeyDown,
		onSubmit,
		onLink,
		onSuggest,
		onMention,
		onFiles,
		mentions,
		documents,
		plan = false,
		commands,
		placeholder,
		defaultValue,
		...props
	}: Props,
) {
	let label = typeof props["aria-label"] === "string" ? props["aria-label"] : undefined;
	let [initial] = useState(() => defaultValue);
	let mount = useRef<HTMLDivElement>(null);
	let mentionsRef = useRef(mentions);
	let view = useRef<EditorView | null>(null);
	let placeholderRef = useRef(placeholder || "");
	let documentsRef = useRef(documents);
	let planRef = useRef(plan);
	let commandsRef = useRef(commands);
	let commandKey = JSON.stringify(
		commands?.map(item => [item.name, item.description, item.icon]) || [],
	);
	let [popup, setPopup] = useState<Popup | null>(null);
	let popupRef = useRef<Popup | null>(null);
	useLayoutEffect(() => {
		mentionsRef.current = mentions;
		documentsRef.current = documents;
		planRef.current = plan;
		commandsRef.current = commands;
		popupRef.current = popup;
	}, [mentions, documents, plan, commands, popup]);

	function show(source: Popup["source"], items: PopupItem[], pos: number) {
		let v = view.current;
		if (!v || !items.length) {
			return setPopup(prev => prev?.source === source ? null : prev);
		}
		setPopup(prev => ({
			source,
			items,
			index: Math.min(prev?.source === source ? prev.index : 0, items.length - 1),
			anchor: getAnchor(v, pos),
		}));
	}

	function hide(source: Popup["source"]) {
		setPopup(prev => prev?.source === source ? null : prev);
	}

	function handleMention(state: SuggestState) {
		onSuggest?.(state);
		if (!state.active || !state.range || !mentions?.length) return hide("mention");
		let q = state.query.toLowerCase();
		let items: PopupItem[] = [];
		for (let m of mentions) {
			if (!m.name.toLowerCase().includes(q)) continue;
			items.push({
				key: m.name,
				label: m.name,
				avatar: m.avatar,
				action: (v) => {
					insertMention(v, m.name, m.id, m.avatar);
					onMention?.(m.name);
				},
			});
		}
		show("mention", items, state.range.from);
	}

	function handleDocument(state: SuggestState) {
		let documents = documentsRef.current;
		let plan = planRef.current;
		if (!state.active || !state.range) return hide("document");
		if (!documents?.length && !plan) return hide("document");
		let q = state.query.toLowerCase();
		let items: PopupItem[] = [];
		if (plan && PLAN_NAME.includes(q)) {
			items.push({
				key: PLAN_NAME,
				label: PLAN_NAME,
				action: insertPlan,
			});
		}
		for (let document of documents || []) {
			let names = [document.name, ...(document.aliases || [])];
			if (!names.some(name => name.toLowerCase().includes(q))) continue;
			items.push({
				key: document.uid,
				label: document.name,
				action: (v) => insertDocument(v, document),
			});
		}
		show("document", items, state.range.from);
	}

	async function handleEmoji(state: SuggestState) {
		if (!state.active || !state.range) return hide("emoji");
		let results = await SearchIndex.search(state.query, { maxResults: 8, caller: null });
		if (!results?.length) return hide("emoji");
		let items = results.map(
			(e: { id: string; name: string; skins: { native?: string; src?: string }[] }) => {
				let skin = e.skins[0]!;
				if (skin.native) {
					return {
						key: e.id,
						label: skin.native + " " + e.name,
						action: (v: EditorView) => insertEmoji(v, skin.native!),
					};
				}
				return {
					key: e.id,
					label: e.name,
					avatar: skin.src,
					action: (v: EditorView) => insertCustomEmoji(v, e.id, e.name, skin.src!),
				};
			},
		);
		show("emoji", items, state.range.from);
	}

	function handleSlash(state: SuggestState) {
		let commands = commandsRef.current;
		if (!state.active || !state.range || !commands?.length) return hide("slash");
		let range = state.range;
		let q = state.query.toLowerCase();
		let items: PopupItem[] = [];
		for (let cmd of commands) {
			if (!cmd.name.toLowerCase().includes(q)) continue;
			items.push({
				key: cmd.name,
				label: cmd.name,
				icon: cmd.icon,
				description: cmd.description,
				action: view => {
					let current = commandsRef.current?.find(item => item.name === cmd.name);
					current?.action(view, range);
				},
			});
		}
		show("slash", items, state.range.from);
	}

	let mention = useEffectEvent(handleMention);
	let inserted = useEffectEvent((name: string) => onMention?.(name));
	let change = useEffectEvent((view: EditorView) => onChange?.(view));
	let update = useEffectEvent((view: EditorView) => onUpdate?.(view));
	let paste = useEffectEvent((slice: Slice) => pasted(slice, mentions, documents, plan));
	let attach = useEffectEvent((e: ClipboardEvent) => {
		let files = getFiles(e);
		if (!files.length) return false;
		// Unhandled, WebKit inserts a pasted image into the editor DOM outside the schema.
		e.preventDefault();
		// Like a drop, every file becomes a chip, so one the channel can't take is visible, not lost.
		onFiles?.(files);
		return true;
	});
	let keydown = useEffectEvent((v: EditorView, e: KeyboardEvent) => {
		let p = popupRef.current;
		if (p && e.key === "ArrowDown") {
			e.preventDefault();
			setPopup({ ...p, index: (p.index + 1) % p.items.length });
			return true;
		}
		if (p && e.key === "ArrowUp") {
			e.preventDefault();
			setPopup({ ...p, index: (p.index - 1 + p.items.length) % p.items.length });
			return true;
		}
		if (p && e.key === "Escape") {
			setPopup(null);
			return true;
		}
		if (p && (e.key === "Enter" || e.key === "Tab")) {
			e.preventDefault();
			setPopup(null);
			p.items[p.index]!.action(v);
			return true;
		}

		if (onKeyDown?.(v, e)) return true;
		let composing = e.isComposing || v.composing;

		if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && exitCodeBlock(v.state, v.dispatch)) {
			e.preventDefault();
			return true;
		}

		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
			e.preventDefault();
			onLink?.(getAnchor(v, v.state.selection.from));
			return true;
		}

		if (!p) {
			// A phone's Return key adds a line, as in other mobile chat apps; its Send button sends.
			if (
				onSubmit && e.key === "Enter" && !composing && !e.shiftKey && !e.metaKey && !e.ctrlKey
				&& !touchOnly()
			) {
				e.preventDefault();
				onSubmit(v);
				return true;
			}
			return false;
		}

		return false;
	});

	useLayoutEffect(() => {
		let el = mount.current;
		if (!el) return;

		initEmoji();

		let doc = initial ? schema.nodeFromJSON(initial) : undefined;
		let parser: ReturnType<typeof createParser> | null = null;
		let ready = getHighlighter().then(h => {
			parser = createParser(h, { theme: "ace" });
		});
		let plugins = [
			slashPlugin(handleSlash),
			emojiPlugin(handleEmoji),
			suggestPlugin(state => mention(state), mentionsRef, name => inserted(name)),
			documentPlugin(handleDocument, documentsRef, planRef),
			createHighlightPlugin({
				parser: (args) => parser ? parser(args) : ready,
				languageExtractor: (node) => node.attrs.params || undefined,
			}),
			inputRules({ rules: [codeBlockRule()] }),
			keymap({
				"Mod-b": toggleBold,
				"Mod-i": toggleItalic,
				"Mod-u": toggleUnderline,
				"Mod-e": toggleCode,
				"Mod-Shift-s": toggleStrike,
				"Mod-Alt-7": toggleOrdered(),
				"Mod-Alt-8": toggleBullet(),
				"Mod-Shift-.": toggleQuote,
				"Mod-Alt-`": toggleCodeBlock,
				"Mod-Enter": exitCodeBlock,
				"Shift-Enter": chainCommands(newlineInCode, exitCode, (state, dispatch) => {
					if (dispatch) {
						let br = state.schema.nodes.hard_break;
						dispatch(state.tr.replaceSelectionWith(br.create()).scrollIntoView());
					}
					return true;
				}),
				"Backspace": backspaceCodeBlock,
				"Mod-z": undo,
				"Mod-Shift-z": redo,
				"Mod-y": redo,
			}),
			keymap(baseKeymap),
			history(),
			placeholderPlugin(placeholderRef),
		];

		let v = new EditorView(el, {
			state: EditorState.create({ schema, doc, plugins }),
			dispatchTransaction(tr) {
				let next = v.state.apply(tr);
				v.updateState(next);
				if (tr.docChanged) change(v);
				update(v);
			},
			handleClick(_view, _pos, e) {
				let target = e.target;
				if (!(target instanceof Element)) return false;
				let link = target.closest("a[href]");
				if (!(link instanceof HTMLAnchorElement)) return false;
				if (!(e.metaKey || e.ctrlKey)) return false;
				e.preventDefault();
				window.open(link.href, "_blank", "noopener,noreferrer");
				return true;
			},
			handleKeyDown: (view, event) => keydown(view, event),
			handleDOMEvents: {
				paste(v, e) {
					if (attach(e)) return true;
					let text = getPaste(e);
					if (!text || !isUrl(text)) return false;
					if (v.state.selection.$from.parent.type === schema.nodes.code_block) return false;
					e.preventDefault();
					return setLink(text)(v.state, v.dispatch);
				},
			},
			clipboardTextParser(text, $context) {
				let content: Node[] = [];
				let marks = $context.marks();
				// Plain-text line breaks must not become paragraph separators.
				for (let [index, line] of text.split(/\r\n?|\n/).entries()) {
					if (index) content.push(schema.nodes.hard_break.create(null, null, marks));
					if (line) content.push(schema.text(line, marks));
				}
				return new Slice(Fragment.fromArray(content), 0, 0);
			},
			transformPasted(slice) {
				return paste(slice);
			},
		});

		view.current = v;
		update(v);

		return () => {
			view.current = null;
			v.destroy();
		};
	}, [initial]);

	useImperativeHandle<EditorView | null, EditorView | null>(ref, () => view.current);
	useEffect(() => {
		view.current?.setProps({ attributes: label ? { "aria-label": label } : undefined });
	}, [label]);

	useEffect(() => {
		placeholderRef.current = placeholder || "";
		let v = view.current;
		if (v) v.dispatch(v.state.tr);
	}, [placeholder]);

	useEffect(() => {
		let v = view.current;
		if (v) v.dispatch(v.state.tr);
	}, [documents, plan]);

	useEffect(() => {
		let v = view.current;
		if (v) v.dispatch(v.state.tr);
	}, [commandKey]);

	return { mount, view, popup, setPopup };
}

function RichText({ className, ...props }: Props) {
	let { mount, view, popup, setPopup } = useEditor(props);
	let {
		ref,
		onChange,
		onUpdate,
		onKeyDown,
		onSubmit,
		onLink,
		onSuggest,
		onMention,
		onFiles,
		mentions,
		documents,
		plan,
		commands,
		placeholder,
		defaultValue,
		...attributes
	} = props;

	return (
		<div
			ref={mount}
			className={cn("rich-text content", className)}
			{...attributes}
		>
			<Popover open={!!popup}>
				<PopoverPortal>
					<PopoverPositioner anchor={popup?.anchor} side="bottom" align="start" sideOffset={4}>
						<PopoverPopup
							className={popup?.source === "slash" ? "w-80 max-w-(--available-width)" : undefined}
							initialFocus={false}
							finalFocus={false}
						>
							{popup?.items.map((item, i) => (
								<button
									key={item.key}
									className={cn(
										"flex min-h-7 w-full items-center gap-2 rounded-md squircle px-2 py-1 text-xs/relaxed outline-hidden select-none",
										i === popup.index
											? "bg-accent text-accent-foreground"
											: "text-popover-foreground",
									)}
									onMouseDown={(e) => {
										e.preventDefault();
										setPopup(null);
										view.current && item.action(view.current);
									}}
								>
									{item.avatar && (
										<img
											className="size-5 shrink-0 rounded-full object-cover"
											src={item.avatar}
											alt=""
										/>
									)}
									{item.icon && (
										<span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[0.6875rem] font-semibold">
											{item.icon}
										</span>
									)}
									<span className="flex min-w-0 flex-1 flex-col gap-px text-left">
										<span className="truncate font-medium">{item.label}</span>
										{item.description && (
											<span className="break-words text-[0.6875rem] text-muted-foreground">
												{item.description}
											</span>
										)}
									</span>
								</button>
							))}
						</PopoverPopup>
					</PopoverPositioner>
				</PopoverPortal>
			</Popover>
		</div>
	);
}

export { type DocumentCandidate, type Mention, RichText, type SlashCommand, type SuggestState };
