import { pick } from "../../lib/emoji";
import {
	type ComponentPropsWithRef,
	type ComponentType,
	Fragment,
	type ReactNode,
	type Ref,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Toolbar } from "@base-ui/react/toolbar";
import * as fuzzysort from "fuzzysort";
import type { MarkType, Node as ProseMirrorNode, NodeType } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { toast } from "sonner";

import { canDictate, useDictation } from "../../hooks/use-dictation";
import { useDraft } from "../../hooks/use-draft";
import { useHistory } from "../../hooks/use-history";
import { useMic } from "../../hooks/use-mic";
import { lookupCustomEmoji } from "../../lib/emoji";
import { parse } from "../../lib/markdown";
import { cn, isUrl } from "../../lib/utils";
import { Button } from "../../ui/button";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
	ComboboxTrigger,
} from "../../ui/combobox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { type Emoji, EmojiPicker } from "../../ui/emoji-picker";
import { Popover, PopoverPopup, PopoverPortal, PopoverPositioner } from "../../ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../ui/tooltip";
import { Waveform } from "../../ui/waveform";

import { type Attachment, AttachmentList } from "./attachment-list";
import { Composer } from "./composer";
import { ComposerToolbar, type ComposerToolbarEvent } from "./composer-toolbar";
import { canSendMessage } from "./send";
import { useAttachments } from "./use-attachments";
import {
	clearLink,
	getLinkInfo,
	setLink as setLinkCmd,
	toggleBold,
	toggleBullet,
	toggleCode,
	toggleCodeBlock,
	toggleItalic,
	toggleOrdered,
	toggleQuote,
	toggleStrike,
	toggleUnderline,
} from "../rich-text/commands";
import {
	type DocumentCandidate,
	type Mention,
	RichText,
	type SlashCommand,
} from "../rich-text/rich-text";
import { schema } from "../rich-text/schema";
import {
	IconArrowUpMicro,
	IconCheckMicro,
	IconChevronDownMicro,
	IconChevronRightMicro,
	IconConsoleMicro,
	IconListTodoMicro,
	IconMessageMicro,
	IconMicMicro,
	IconSparkleMicro,
	IconStopFilledMicro,
	IconTextMicro,
	IconXMicro,
} from "../../icons";

/** A selectable mode (e.g. Chat, Ace, Plan, Terminal). */
type Mode = {
	id: string;
	name: string;
	placeholder: string;
	/** Optional icon shown in the mode picker. */
	icon?: ComponentType<{ className?: string }>;
	/** If set, auto-inserts the named mention when this mode is active. */
	mention?: string;
	/** Visual/behavioral variant. Defaults to "chat". */
	kind?: "chat" | "terminal";
	/** Terminal-only: CWD path segments shown as the input placeholder. */
	cwd?: string[];
};

/** A selectable model (e.g. Opus, Sonnet). */
type Model = {
	id: string;
	name: string;
	vendor?: string;
};

/** A reasoning effort accepted by the selected model. */
type Effort = { id: string; name: string };

/** A selectable agent or execution mode. */
type Agent = {
	id: string;
	name: string;
	description?: string;
	group?: string;
	color?: string;
	icon?: ComponentType<{ className?: string }>;
};

function text(model: Model) {
	return [model.name, model.id, model.vendor].filter(Boolean).join(" ");
}

function glyph(mode?: Mode): ComponentType<{ className?: string }> {
	if (mode?.icon) return mode.icon;
	if (mode?.kind === "terminal") return IconConsoleMicro;
	switch (mode?.id) {
		case "ace":
			return IconSparkleMicro;
		case "plan":
			return IconListTodoMicro;
		default:
			return IconMessageMicro;
	}
}

/** Payload passed to `onSend`. */
type SendPayload = {
	doc: ProseMirrorNode;
	text: string;
	attachments: Attachment[];
	mode: string;
	model?: string;
	agent?: string;
};

/** Imperative handle exposed via `ref`. */
type ChatComposerHandle = {
	focus: () => void;
	/** Read the current document without changing the editor or its saved draft. */
	get: () => ProseMirrorNode | undefined;
	clear: () => void;
	set: (text: string) => void;
	insert: (text: string) => void;
};

type Props = {
	/** Storage scope for drafts and recalled messages. Defaults to the current pathname. */
	scope?: string;
	mentions?: Mention[];
	/** Documents available for &name.md references. */
	documents?: readonly DocumentCandidate[];
	/** Enables the reserved Plan reference in & autocomplete. */
	plan?: boolean;
	commands?: SlashCommand[];
	/** Available modes. Defaults to a single "chat" mode. */
	modes?: Mode[];
	/** Available models. Omit to hide the model picker. */
	models?: Model[];
	/** Available agents and execution modes. Omit to hide the agent picker. */
	agents?: Agent[];
	/** Overrides the active mode's placeholder. */
	placeholder?: string;
	/** Enables dictation where the runtime can transcribe speech. Defaults to false. */
	mic?: boolean;
	mode?: string;
	onModeChange?: (mode: string) => void;
	model?: string;
	onModelChange?: (model: string) => void;
	agent?: string;
	onAgentChange?: (agent: string) => void;
	/** Reasoning efforts for the selected model. Omit to hide the effort picker. */
	efforts?: Effort[];
	effort?: string;
	onEffortChange?: (effort: string) => void;
	attachments?: Attachment[];
	onAttachmentsChange?: (next: Attachment[]) => void;
	onTypingChange?: (value: boolean) => void;
	onTextChange?: (text: string) => void;
	/** Whether an agent response is in progress. */
	busy?: boolean;
	/** Whether the submit control should show a loading state. */
	submitBusy?: boolean;
	/** The loading submit control's label, naming what submission waits on. */
	submitLabel?: string;
	/** Whether the Stop control should be shown. Defaults to `busy`. */
	canStop?: boolean;
	/** Whether attachments can be added. Defaults to `true`. */
	canAttach?: boolean;
	/** Whether the current draft is editing an existing message. */
	editing?: boolean;
	/** Whether submitting the current edit reruns Ace. */
	editingRerun?: boolean;
	/** Whether submitting is currently allowed. Defaults to true. */
	canSend?: boolean;
	/** Whether the composer clears immediately after submit. Defaults to true. */
	clearOnSend?: boolean;
	/** Called when the user stops the active agent response. */
	onStop?: () => void;
	/** Called when the user cancels message editing. */
	onCancelEdit?: () => void;
	/** Called when the full-terminal button is clicked. */
	onTerminalExpand?: () => void;
	/** Whether the formatting toolbar starts open. Defaults to true. */
	tools?: boolean;
	/** Called when the user submits. */
	onSend: (payload: SendPayload) => void;
	/** Shown just before the submit control, e.g. a context meter. */
	accessory?: ReactNode;
	className?: string;
	ref?: Ref<ChatComposerHandle>;
};

type Active = {
	bold: boolean;
	italic: boolean;
	underline: boolean;
	strike: boolean;
	link: boolean;
	ordered: boolean;
	bullet: boolean;
	quote: boolean;
	code: boolean;
	pre: boolean;
};

type LinkState = {
	open: boolean;
	name: string;
	href: string;
	anchor: HTMLElement | { getBoundingClientRect: () => DOMRect } | null;
};

type EmojiState = {
	open: boolean;
	anchor: HTMLElement | { getBoundingClientRect: () => DOMRect } | null;
};

type Command = (
	state: EditorView["state"],
	dispatch?: (tr: EditorView["state"]["tr"]) => void,
) => boolean;

type StopProps = ComponentPropsWithRef<"button">;

function Stop({
	className,
	type = "button",
	"aria-label": label = "Stop response",
	...props
}: StopProps) {
	return (
		<button
			type={type}
			aria-label={label}
			className={cn(
				"relative flex size-6 shrink-0 items-center justify-center rounded-full! bg-red-500 text-white shadow-sm contain-content transition-[scale] duration-150 active:scale-[0.96] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				className,
			)}
			{...props}
		>
			<IconStopFilledMicro className="size-3" />
		</button>
	);
}

type CancelProps = ComponentPropsWithRef<"button">;

function Cancel({
	className,
	type = "button",
	"aria-label": label = "Cancel edit",
	...props
}: CancelProps) {
	return (
		<button
			type={type}
			aria-label={label}
			className={cn(
				"relative flex size-6 shrink-0 items-center justify-center rounded-full! bg-secondary text-muted-foreground shadow-sm contain-content transition-[background-color_300ms_ease-out,color_300ms_ease-out,scale_150ms] hover:bg-muted hover:text-foreground active:scale-[0.96] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				className,
			)}
			{...props}
		>
			<IconXMicro className="size-3" />
		</button>
	);
}

const DEFAULT_MODES: Mode[] = [
	{ id: "chat", name: "Chat", placeholder: "Chat with your team, @ to mention" },
];

const EMPTY_MODELS: Model[] = [];

const EMPTY_ACTIVE: Active = {
	bold: false,
	italic: false,
	underline: false,
	strike: false,
	link: false,
	ordered: false,
	bullet: false,
	quote: false,
	code: false,
	pre: false,
};

const EMPTY_LINK: LinkState = { open: false, name: "", href: "", anchor: null };
const EMPTY_EMOJI: EmojiState = { open: false, anchor: null };
const IDLE = 5000;
const ESCAPE_WINDOW = 350;

const ACTIONS = {
	bold: toggleBold,
	italic: toggleItalic,
	underline: toggleUnderline,
	strike: toggleStrike,
	ordered: toggleOrdered(),
	bullet: toggleBullet(),
	quote: toggleQuote,
	code: toggleCode,
	pre: toggleCodeBlock,
} satisfies Record<Exclude<ComposerToolbarEvent["action"], "attach" | "emoji" | "link">, Command>;

function hasMark(view: EditorView, type: MarkType) {
	let { state } = view;
	let { from, to, empty } = state.selection;
	if (empty) return !!type.isInSet(state.storedMarks || state.selection.$from.marks());
	return state.doc.rangeHasMark(from, to, type);
}

function hasNode(view: EditorView, type: NodeType) {
	let { $from } = view.state.selection;
	for (let d = $from.depth; d > 0; d--) {
		if ($from.node(d).type === type) return true;
	}
	return false;
}

function getActive(view: EditorView): Active {
	return {
		bold: hasMark(view, schema.marks.strong),
		italic: hasMark(view, schema.marks.em),
		underline: hasMark(view, schema.marks.underline),
		strike: hasMark(view, schema.marks.strike),
		link: hasMark(view, schema.marks.link),
		ordered: hasNode(view, schema.nodes.ordered_list),
		bullet: hasNode(view, schema.nodes.bullet_list),
		quote: hasNode(view, schema.nodes.blockquote),
		code: hasMark(view, schema.marks.code),
		pre: view.state.selection.$from.parent.type === schema.nodes.code_block,
	};
}

function hasMention(view: EditorView, name: string) {
	let found = false;
	view.state.doc.descendants(node => {
		if (found) return false;
		if (isMention(node, name)) found = true;
	});
	return found;
}

function isMention(node: ProseMirrorNode, name: string) {
	return node.type === schema.nodes.mention
		&& typeof node.attrs.name === "string"
		&& node.attrs.name.toLowerCase() === name.toLowerCase();
}

function demoteMentions(view: EditorView, name: string) {
	let { tr } = view.state;
	let changed = false;
	view.state.doc.descendants((node, pos) => {
		if (!isMention(node, name)) return;
		let from = tr.mapping.map(pos);
		changed = true;
		let end = from + node.nodeSize;
		// The leading mention is the mode's marker, not the person's words; leaving the mode drops it.
		if (pos === 1) tr.delete(from, tr.doc.textBetween(end, end + 1) === " " ? end + 1 : end);
		else tr.replaceWith(from, end, schema.text(node.attrs.name));
	});
	if (changed) view.dispatch(tr);
	return changed;
}

function demoteLeadingMention(view: EditorView, name: string) {
	let block = view.state.doc.firstChild;
	if (!block?.isTextblock) return false;

	let start = 1;
	let text = `@${name}`;
	let lower = text.toLowerCase();
	let offset = 0;

	for (let i = 0; i < block.childCount; i++) {
		let node = block.child(i);
		let pos = start + offset;
		if (node.isText) {
			let value = node.text || "";
			let i = value.length - value.trimStart().length;
			if (i === value.length) {
				offset += node.nodeSize;
				continue;
			}
			if (value.slice(i, i + text.length).toLowerCase() !== lower) {
				break;
			}
			let after = value[i + text.length];
			if (after && !/\s/.test(after)) {
				break;
			}
			view.dispatch(view.state.tr.delete(pos + i, pos + i + 1));
			return true;
		}
		if (isMention(node, name)) {
			view.dispatch(
				view.state.tr.replaceWith(pos, pos + node.nodeSize, schema.text(node.attrs.name)),
			);
			return true;
		}
		break;
	}

	return false;
}

function promoteMention(view: EditorView, entry: Mention) {
	let block = view.state.doc.firstChild;
	if (!block?.isTextblock) return false;

	let start = 1;
	let size = entry.name.length;
	let lower = entry.name.toLowerCase();
	let offset = 0;

	for (let i = 0; i < block.childCount; i++) {
		let node = block.child(i);
		let pos = start + offset;
		if (!node.isText) break;

		let value = node.text || "";
		let j = value.length - value.trimStart().length;
		if (j === value.length) {
			offset += node.nodeSize;
			continue;
		}
		if (value.slice(j, j + size).toLowerCase() !== lower) {
			break;
		}
		let after = value[j + size];
		if (after && !/\s/.test(after)) {
			break;
		}

		let mention = schema.nodes.mention.create({
			id: entry.id ?? null,
			name: entry.name,
			avatar: entry.avatar ?? null,
		});
		view.dispatch(view.state.tr.replaceWith(pos + j, pos + j + size, mention));
		return true;
	}

	return false;
}

function insertModeMention(view: EditorView, entry: Mention) {
	let tr = view.state.tr.insert(1, [modeMention(entry), schema.text(" ")]);
	view.dispatch(tr.setSelection(view.state.selection.map(tr.doc, tr.mapping)));
}

function modeMention(entry: Mention) {
	return schema.nodes.mention.create({
		id: entry.id ?? null,
		name: entry.name,
		avatar: entry.avatar ?? null,
	});
}

function presentation({
	modes,
	curMode,
	editing,
	canAttach,
	curAttach,
	value,
	canSend,
	canStop,
	busy,
	onStop,
	models,
	agents,
	curAgent,
	query,
	editingRerun,
	recording,
	mic,
	empty,
}: {
	modes: Mode[];
	curMode: string;
	editing: boolean;
	canAttach: boolean;
	curAttach: Attachment[];
	value: string;
	canSend: boolean;
	canStop?: boolean;
	busy: boolean;
	onStop?: () => void;
	models?: Model[];
	agents?: Agent[];
	curAgent?: string;
	query: string;
	editingRerun: boolean;
	recording: boolean;
	mic: boolean;
	empty: boolean;
}) {
	let item = modes.find(m => m.id === curMode);
	let terminal = item?.kind === "terminal";
	let edit = editing && !terminal;
	let attachable = canAttach && !edit;
	let current = edit ? modes[0] ?? item : item;
	let cwd = current?.cwd?.join("/");
	let CurrentIcon = glyph(current);
	let id = current?.id ?? curMode;
	let ace = id === "ace" && !terminal;
	let planning = id === "plan" && !terminal;
	let attach = terminal ? [] : curAttach;
	let filled = !!value.trim() || attach.length > 0;
	let sendable = canSendMessage({ text: value, attachments: attach, enabled: canSend });
	let stop = (canStop ?? busy) && !!onStop;
	let showMode = modes.length > 1;
	let showModel = !edit && ace && !!models?.length;
	let showAgent = !edit && ace && !!agents?.length;
	let selectedAgent = agents?.find(item => item.id === curAgent) ?? agents?.[0];
	let AgentIcon = selectedAgent?.icon
		?? (selectedAgent?.id === "plan" ? IconListTodoMicro : IconSparkleMicro);
	let filtering = query.trim().length > 0;
	// The submit button doubles as the mic only while there is nothing to send; otherwise the
	// options toolbar carries the mic so dictation can still extend a draft.
	let voice = mic && !busy && empty && !curAttach.length;
	let tip = terminal
		? "Run"
		: edit
		? editingRerun ? "Save & rerun" : "Save edit"
		: recording
		? "Stop recording"
		: voice
		? "Record"
		: "Send";

	return {
		terminal,
		edit,
		attachable,
		current,
		cwd,
		CurrentIcon,
		ace,
		planning,
		filled,
		sendable,
		stop,
		showMode,
		showModel,
		showAgent,
		selectedAgent,
		AgentIcon,
		filtering,
		voice,
		tip,
	};
}

/** Opinionated chat composer: rich text, attachments, mentions, slash commands,
 * modes, models, and an optional microphone. */
function useComposer({
	scope,
	mentions,
	documents,
	plan = false,
	commands,
	modes = DEFAULT_MODES,
	models,
	agents,
	placeholder,
	mic: dictation = false,
	mode,
	onModeChange,
	model,
	onModelChange,
	agent,
	onAgentChange,
	efforts,
	effort,
	onEffortChange,
	attachments,
	onAttachmentsChange,
	onTypingChange,
	onTextChange,
	busy = false,
	submitBusy = false,
	submitLabel,
	canStop,
	canAttach = true,
	editing = false,
	editingRerun = false,
	canSend = true,
	clearOnSend = true,
	onStop,
	onCancelEdit,
	onTerminalExpand,
	tools = true,
	onSend,
	accessory,
	className,
	ref,
}: Props) {
	let [modeState, setModeState] = useState(mode ?? modes[0]!.id);
	let [modelState, setModelState] = useState(model ?? models?.[0]?.id);
	let [agentState, setAgentState] = useState(agent ?? agents?.[0]?.id);
	let {
		current: curAttach,
		ref: attachRef,
		add: addFiles,
		remove: removeAttach,
		reset: resetAttach,
	} = useAttachments(
		attachments,
		onAttachmentsChange,
	);
	let anchor = useRef<HTMLDivElement | null>(null);

	let curMode = mode ?? (modes.some(item => item.id === modeState) ? modeState : modes[0]!.id);
	let curModel = model
		?? (models?.some(item => item.id === modelState) ? modelState : models?.[0]?.id);
	let curAgent = agent
		?? (agents?.some(item => item.id === agentState) ? agentState : agents?.[0]?.id);
	let items = models ?? EMPTY_MODELS;
	let [query, setQuery] = useState("");
	let results = useMemo(() => {
		let q = query.trim();
		if (!q) return items;
		let values = items.map(item => ({ item, value: text(item) }));
		return fuzzysort.go(q, values, { key: "value" }).map(match => match.obj.item);
	}, [items, query]);
	let selected = items.find(item => item.id === curModel) ?? items[0];

	let [empty, setEmpty] = useState(true);
	let [value, setValue] = useState("");
	let [recording, setRecording] = useState(false);
	let [toolbar, setToolbar] = useState(tools);
	let [modelMenu, setModelMenu] = useState(false);
	let [keys, setKeys] = useState(false);
	let [active, setActive] = useState(EMPTY_ACTIVE);
	let [link, setLinkState] = useState<LinkState>(EMPTY_LINK);
	let [emoji, setEmoji] = useState<EmojiState>(EMPTY_EMOJI);

	let draft = useDraft(scope);
	let restoredMode = useRef(draft.defaultValue ? curMode : undefined);
	let history = useHistory(scope);
	let mic = dictation && canDictate;
	let analyser = useMic(mic && recording);
	let dictated = useRef({ from: 0, size: 0, before: "", after: "" });
	useDictation(mic && recording, (text) => {
		let v = view.current!;
		let { from, size, before, after } = dictated.current;
		let words = before + text + after;
		v.dispatch(v.state.tr.insertText(words, from, from + size));
		dictated.current.size = words.length;
	}, (reason) => {
		setRecording(false);
		if (reason) toast("Voice input stopped", { description: reason });
	});

	let view = useRef<EditorView | null>(null);
	let file = useRef<HTMLInputElement | null>(null);
	let selection = useRef<{ from: number; to: number } | null>(null);

	let inputs = {
		modes,
		mentions,
		documents,
		plan,
		onModeChange,
		onModelChange,
		onAgentChange,
		onAttachmentsChange,
		onTypingChange,
		onTextChange,
		onCancelEdit,
		onSend,
		mode,
		model,
		agent,
		attachments,
		editing,
	};
	let latest = useRef(inputs);

	let modeRef = useRef(curMode);
	let modelRef = useRef(curModel);
	let agentRef = useRef(curAgent);
	// Handlers stage ref updates before React commits. Reconcile even when controlled props stay equal.
	useLayoutEffect(() => {
		latest.current = inputs;
		modeRef.current = curMode;
		modelRef.current = curModel;
		agentRef.current = curAgent;
	});
	let typing = useRef(false);
	let esc = useRef(0);
	let timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	let pendingModel = useRef<string | undefined>(undefined);

	function type(value: boolean, force = false) {
		if (timer.current) {
			clearTimeout(timer.current);
			timer.current = undefined;
		}
		let changed = typing.current !== value;
		if (changed) {
			typing.current = value;
		}
		if (changed || force) {
			latest.current.onTypingChange?.(value);
		}
		if (value) timer.current = setTimeout(() => type(false), IDLE);
	}

	useEffect(() => {
		return () => {
			type(false);
			if (timer.current) clearTimeout(timer.current);
		};
	}, []);

	function updateMode(next: string | ((prev: string) => string)) {
		let v = typeof next === "function" ? next(modeRef.current) : next;
		if (v === modeRef.current) return;
		modeRef.current = v;
		if (latest.current.mode === undefined) setModeState(v);
		latest.current.onModeChange?.(v);
	}

	function updateModel(next: string) {
		if (next === modelRef.current) return;
		modelRef.current = next;
		if (latest.current.model === undefined) setModelState(next);
		latest.current.onModelChange?.(next);
	}

	function updateAgent(next: string) {
		if (next === agentRef.current) return;
		agentRef.current = next;
		if (latest.current.agent === undefined) setAgentState(next);
		latest.current.onAgentChange?.(next);
	}

	function commitModel() {
		let next = pendingModel.current;
		pendingModel.current = undefined;
		if (next) updateModel(next);
	}

	function openModelMenu(open: boolean) {
		setModelMenu(open);
		if (open) {
			setKeys(false);
			setQuery("");
			commitModel();
		}
	}

	function completeModelMenu(open: boolean) {
		if (open) return;
		setQuery("");
		commitModel();
	}

	function selectModel(next: string) {
		if (next === modelRef.current) return;
		pendingModel.current = next;
		setModelMenu(false);
	}

	function choose(next: Model | null) {
		if (next) selectModel(next.id);
	}

	function focus(type: string) {
		setKeys(type === "keyboard");
		return true;
	}

	function clear() {
		let v = view.current;
		if (!v) return;
		let mode = latest.current.modes.find(m => m.id === modeRef.current);
		let entry = mode?.mention
			? latest.current.mentions?.find(m => m.name === mode.mention)
			: undefined;
		let doc = parse();
		let tr = v.state.tr.replaceWith(0, v.state.doc.content.size, doc.content);
		if (!latest.current.editing && entry) {
			tr = tr.insert(1, [modeMention(entry), schema.text(" ")]);
			tr = tr.setSelection(TextSelection.atEnd(tr.doc));
		}
		v.dispatch(tr);
		draft.clear();
		type(false);
	}

	function cancel() {
		clear();
		latest.current.onCancelEdit?.();
		view.current?.focus();
	}

	function exit() {
		updateMode(modes[0]!.id);
		view.current?.focus();
	}

	useImperativeHandle(ref, () => ({
		focus: () => view.current?.focus(),
		get: () => view.current?.state.doc,
		clear,
		set: (text: string) => {
			let v = view.current;
			if (!v) return;
			let doc = parse(
				text,
				latest.current.mentions,
				latest.current.documents,
				latest.current.plan,
			);
			let tr = v.state.tr.replaceWith(0, v.state.doc.content.size, doc.content);
			v.dispatch(tr.setSelection(TextSelection.atEnd(tr.doc)));
			v.focus();
		},
		insert: (text: string) => {
			let v = view.current;
			if (!v) return;
			v.dispatch(v.state.tr.insertText(text));
			v.focus();
		},
	}));

	// Sync mention-modes: keep the doc in sync with the active mode.
	useEffect(() => {
		let v = view.current;
		if (!v || !mentions?.length) return;
		if (latest.current.editing) return;
		// Preserve restored mentions until their inferred mode reaches the controlled prop.
		if (restoredMode.current === curMode) return;
		restoredMode.current = undefined;

		for (let m of modes) {
			if (m.id === curMode || !m.mention) continue;
			demoteMentions(v, m.mention);
		}

		let target = modes.find(m => m.id === curMode);
		if (!target?.mention) return;
		let entry = mentions.find(x => x.name === target.mention);
		if (!entry || hasMention(v, entry.name)) return;
		if (promoteMention(v, entry)) return;

		insertModeMention(v, entry);
	}, [curMode, mentions, modes]);

	function run(cmd: Command) {
		let v = view.current;
		if (!v) return;
		cmd(v.state, v.dispatch);
		v.focus();
	}

	function closeLink() {
		selection.current = null;
		setLinkState(EMPTY_LINK);
	}

	function closeEmoji() {
		setEmoji(EMPTY_EMOJI);
	}

	function openEmoji(anchor: HTMLElement | { getBoundingClientRect: () => DOMRect }) {
		closeLink();
		setEmoji(prev => prev.open && prev.anchor === anchor ? EMPTY_EMOJI : { open: true, anchor });
	}

	function insertEmoji(item: Emoji) {
		let v = view.current;
		if (v) {
			let { from } = v.state.selection;
			let custom = item.native ? undefined : lookupCustomEmoji(item.id);
			let tr = custom
				? v.state.tr.insert(
					from,
					schema.nodes.emoji.create({ id: item.id, name: custom.alt, src: custom.src }),
				)
				: v.state.tr.insertText(pick(item), from);
			v.dispatch(tr);
			v.focus();
		}
		closeEmoji();
	}

	function openLink(anchor: HTMLElement | { getBoundingClientRect: () => DOMRect }) {
		closeEmoji();
		let v = view.current;
		if (!v) return;
		let current = getLinkInfo(v.state);
		let { from, to, empty } = v.state.selection;
		let text = empty ? "" : v.state.doc.textBetween(from, to, " ");
		let name = "";
		let href = "";

		if (current) {
			name = current.text;
			href = current.href;
		} else if (text) {
			if (isUrl(text)) href = text;
			else name = text;
		}

		setLinkState({ open: true, name, href, anchor });
		selection.current = { from, to };
	}

	function restore() {
		let v = view.current;
		let range = selection.current;
		if (!v || !range) return null;
		v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, range.from, range.to)));
		return v;
	}

	function saveLink() {
		let v = restore();
		if (!v) return closeLink();
		if (!link.href.trim()) clearLink(v.state, v.dispatch);
		else setLinkCmd(link.href, link.name)(v.state, v.dispatch);
		closeLink();
		v.focus();
	}

	function removeLink() {
		let v = restore();
		if (!v) return closeLink();
		clearLink(v.state, v.dispatch);
		closeLink();
		v.focus();
	}

	function record() {
		// Browsers expose the microphone only to secure pages, such as a host's tailnet HTTPS address.
		if (!window.isSecureContext) {
			toast("Voice input needs HTTPS", {
				description:
					"Browsers keep the microphone off over HTTP. Open Ace at this host's https:// address to dictate.",
			});
			return;
		}
		let { doc, selection: { from, to } } = view.current!.state;
		// Like system dictation: replace the selection, and keep spaces between the words already
		// there and the dictated ones.
		let before = /\S/.test(doc.textBetween(Math.max(0, from - 1), from)) ? " " : "";
		let after = /\w/.test(doc.textBetween(to, Math.min(doc.content.size, to + 1))) ? " " : "";
		dictated.current = { from, size: to - from, before, after };
		setRecording(true);
	}

	function send() {
		let v = view.current;
		if (!v) return;
		setRecording(false);
		let text = v.state.doc.textContent;
		let sentMode = modeRef.current;
		let mode = latest.current.modes.find(item => item.id === sentMode);
		let attachments = mode?.kind === "terminal" ? [] : attachRef.current;
		if (!canSendMessage({ text, attachments, enabled: canSend })) return;
		type(false);
		latest.current.onSend({
			doc: v.state.doc,
			text,
			attachments,
			mode: sentMode,
			model: modelRef.current,
			agent: agentRef.current,
		});
		history.push(v, sentMode);
		if (clearOnSend) {
			clear();
			resetAttach();
		}
		v.focus();
	}

	function action(event: ComposerToolbarEvent) {
		if (event.action === "attach") {
			if (attachable) file.current?.click();
			return;
		}
		if (event.action === "emoji") return openEmoji(event.trigger);
		if (event.action === "link") return openLink(event.trigger);
		run(ACTIONS[event.action]);
	}

	function change(v: EditorView) {
		draft.save(v);
		history.reset();
		let value = Boolean(v.state.doc.textContent);
		type(value, value);
	}

	function keydown(v: EditorView, e: KeyboardEvent) {
		let ms = latest.current.modes;
		if (!ms.length) return false;
		if (e.key === "Escape" && latest.current.editing) {
			esc.current = 0;
			e.preventDefault();
			cancel();
			return true;
		}
		if (e.key === "Escape") {
			if (e.repeat) return true;
			let now = e.timeStamp;
			let last = esc.current;
			if (modeRef.current !== ms[0]!.id) {
				esc.current = 0;
				e.preventDefault();
				let cur = ms.find(m => m.id === modeRef.current);
				updateMode(ms[0]!.id);
				if (cur?.mention) {
					demoteMentions(v, cur.mention)
						|| demoteLeadingMention(v, cur.mention);
				}
				return true;
			}
			let ace = ms.find(m => m.id === "ace");
			if (ace && last > 0 && now - last <= ESCAPE_WINDOW) {
				esc.current = 0;
				e.preventDefault();
				updateMode(ace.id);
				return true;
			}
			esc.current = now;
			for (let m of ms) {
				if (!m.mention || !demoteLeadingMention(v, m.mention)) continue;
				e.preventDefault();
				return true;
			}
		}
		if (e.key === "!" && !e.metaKey && !e.ctrlKey && !v.state.doc.textContent) {
			let term = ms.find(m => m.kind === "terminal");
			if (term && modeRef.current !== term.id) {
				e.preventDefault();
				updateMode(term.id);
				return true;
			}
		}
		return history.handleKey(v, e, m => updateMode(m || ms[0]!.id), modeRef.current);
	}

	function update(v: EditorView) {
		setActive(getActive(v));
		let text = v.state.doc.textContent;
		let value = Boolean(text);
		setValue(text);
		setEmpty(!value);
		latest.current.onTextChange?.(text);

		let ms = latest.current.modes;
		let list = latest.current.mentions;
		if (!list?.length) return;

		for (let m of ms) {
			if (!m.mention) continue;
			if (hasMention(v, m.mention) && modeRef.current !== m.id) {
				return updateMode(m.id);
			}
		}
		let cur = ms.find(m => m.id === modeRef.current);
		if (cur?.mention && !hasMention(v, cur.mention)) updateMode(ms[0]!.id);
	}

	let {
		terminal,
		edit,
		attachable,
		current,
		cwd,
		CurrentIcon,
		ace,
		planning,
		filled,
		sendable,
		stop,
		showMode,
		showModel,
		showAgent,
		selectedAgent,
		AgentIcon,
		filtering,
		voice,
		tip,
	} = presentation({
		modes,
		curMode,
		editing,
		canAttach,
		curAttach,
		value,
		canSend,
		canStop,
		busy,
		onStop,
		models,
		agents,
		curAgent,
		query,
		editingRerun,
		recording,
		mic,
		empty,
	});

	return {
		mentions,
		documents,
		plan,
		commands,
		modes,
		agents,
		efforts,
		effort,
		onEffortChange,
		placeholder,
		mic,
		canSend,
		busy,
		submitBusy,
		submitLabel,
		onStop,
		onTerminalExpand,
		accessory,
		className,
		curAttach,
		analyser,
		recording,
		toolbar,
		terminal,
		ace,
		attachable,
		edit,
		active,
		file,
		view,
		draft,
		change,
		keydown,
		update,
		openLink,
		send,
		cwd,
		current,
		addFiles,
		removeAttach,
		action,
		showMode,
		showAgent,
		showModel,
		CurrentIcon,
		updateMode,
		selectedAgent,
		AgentIcon,
		curAgent,
		updateAgent,
		items,
		results,
		selected,
		query,
		modelMenu,
		filtering,
		voice,
		openModelMenu,
		completeModelMenu,
		setQuery,
		choose,
		anchor,
		focus,
		keys,
		curModel,
		setToolbar,
		sendable,
		tip,
		stop,
		exit,
		empty,
		filled,
		planning,
		record,
		setRecording,
		cancel,
		link,
		closeLink,
		setLinkState,
		saveLink,
		removeLink,
		emoji,
		closeEmoji,
		insertEmoji,
	};
}

type ComposerState = ReturnType<typeof useComposer>;

function ChatComposer(props: Props) {
	let state = useComposer(props);
	let {
		className,
		curAttach,
		terminal,
		removeAttach,
		mic,
		analyser,
		recording,
		ace,
		attachable,
		addFiles,
		file,
		edit,
		toolbar,
		active,
		action,
		view,
		draft,
		mentions,
		documents,
		plan,
		commands,
		openLink,
		change,
		keydown,
		send,
		update,
		placeholder,
		cwd,
		current,
	} = state;
	return (
		<Composer className={className}>
			<Composer.Attachments open={curAttach.length > 0 && !terminal}>
				<AttachmentList attachments={curAttach} onRemove={removeAttach} />
			</Composer.Attachments>
			{mic && !terminal && <Composer.Glow analyser={analyser} active={recording} />}
			<Composer.Body
				className={cn(
					"transition-shadow duration-300",
					!terminal && recording && "shadow-[0_0_0_1px_rgb(239_68_68)]",
				)}
				data-beam={ace ? "ace" : undefined}
				onFiles={attachable ? addFiles : undefined}
			>
				<input
					ref={file}
					type="file"
					multiple
					className="hidden"
					onChange={(e) => {
						if (edit) {
							e.target.value = "";
							return;
						}
						let files = Array.from(e.target.files || []);
						if (files.length) addFiles(files);
						e.target.value = "";
					}}
				/>
				<Composer.Header open={toolbar && !terminal}>
					<ComposerToolbar disabled={{ attach: !attachable }} value={active} onAction={action} />
				</Composer.Header>
				<Composer.Input data-mode={terminal ? "terminal" : undefined}>
					{terminal && (
						<div className="pointer-events-none mt-3 flex h-[calc(0.8125rem*1.5)] shrink-0 items-center pl-3 text-muted-foreground">
							<IconChevronRightMicro className="size-3.5" />
						</div>
					)}
					<RichText
						ref={view}
						aria-label="Message"
						defaultValue={draft.defaultValue}
						mentions={mentions}
						documents={documents}
						plan={plan}
						commands={commands}
						onLink={openLink}
						onChange={change}
						onKeyDown={keydown}
						onSubmit={send}
						onUpdate={update}
						onFiles={attachable ? addFiles : undefined}
						placeholder={placeholder ?? (terminal && cwd ? cwd : current?.placeholder)}
						className="text-sm text-foreground"
					/>
				</Composer.Input>
				<Composer.Footer>
					<ComposerOptions state={state} />
					<ComposerButtons state={state} />
				</Composer.Footer>
			</Composer.Body>
			<ComposerLink state={state} />
			<ComposerEmoji state={state} />
		</Composer>
	);
}

function ComposerMode({ state }: { state: ComposerState }) {
	let { edit, CurrentIcon, current, modes, updateMode, view } = state;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Toolbar.Button
						disabled={edit}
						focusableWhenDisabled={false}
						render={
							<Button
								variant="ghost"
								size="sm"
								className="h-6.5 px-2 text-muted-foreground disabled:opacity-40"
							/>
						}
					/>
				}
			>
				<CurrentIcon className="size-3" />
				{current?.name}
				<IconChevronDownMicro className="size-3 transition-transform duration-150 group-data-[popup-open]/button:scale-y-[-1]" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" sideOffset={6}>
				{modes.map(m => {
					let Icon = glyph(m);
					return (
						<DropdownMenuItem
							key={m.id}
							onClick={() => {
								updateMode(m.id);
								view.current?.focus();
							}}
						>
							<Icon className="size-3 shrink-0 text-muted-foreground group-focus/dropdown-menu-item:text-popover-foreground" />
							<span className="min-w-0 flex-1 truncate">{m.name}</span>
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ComposerAgent({ state }: { state: ComposerState }) {
	let { AgentIcon, selectedAgent, agents, updateAgent, view, curAgent } = state;
	if (!selectedAgent) return null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Toolbar.Button
						render={
							<Button
								variant="ghost"
								size="sm"
								className="h-6.5 px-2 text-muted-foreground"
							/>
						}
					/>
				}
			>
				<AgentIcon className="size-3" style={{ color: selectedAgent.color }} />
				<span className="max-w-32 truncate">{selectedAgent.name}</span>
				<IconChevronDownMicro className="size-3 transition-transform duration-150 group-data-[popup-open]/button:scale-y-[-1]" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" sideOffset={6} className="inline-auto min-inline-56">
				{agents?.map((entry, index) => {
					let EntryIcon = entry.icon
						?? (entry.id === "plan" ? IconListTodoMicro : IconSparkleMicro);
					let group = entry.group && entry.group !== agents[index - 1]?.group;
					return (
						<Fragment key={entry.id}>
							{group && <DropdownMenuSeparator />}
							{group && <DropdownMenuLabel>{entry.group}</DropdownMenuLabel>}
							<DropdownMenuItem
								onClick={() => {
									updateAgent(entry.id);
									view.current?.focus();
								}}
							>
								<EntryIcon
									className="size-3 shrink-0"
									style={{ color: entry.color }}
								/>
								<span className="min-w-0 flex-1">
									<span className="block truncate">{entry.name}</span>
									{entry.description && (
										<span className="block max-w-64 truncate text-[0.6875rem] text-muted-foreground">
											{entry.description}
										</span>
									)}
								</span>
								{entry.id === curAgent && <IconCheckMicro className="size-3" />}
							</DropdownMenuItem>
						</Fragment>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ComposerEffort({ state }: { state: ComposerState }) {
	let { efforts, effort, onEffortChange, view } = state;
	let selected = efforts?.find(item => item.id === effort);
	if (!selected || !onEffortChange) return null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Toolbar.Button
						aria-label={`Reasoning effort: ${selected.name}`}
						render={
							<Button
								variant="ghost"
								size="sm"
								className="h-6.5 px-2 text-muted-foreground"
							/>
						}
					/>
				}
			>
				<span className="truncate">{selected.name}</span>
				<IconChevronDownMicro className="size-3 transition-transform duration-150 group-data-[popup-open]/button:scale-y-[-1]" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" sideOffset={6} className="min-w-36">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
					{efforts?.map(entry => (
						<DropdownMenuItem
							key={entry.id}
							onClick={() => {
								onEffortChange(entry.id);
								view.current?.focus();
							}}
						>
							<span className="min-w-0 flex-1 truncate">{entry.name}</span>
							{entry.id === effort && <IconCheckMicro className="size-3" />}
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ComposerModel({ state }: { state: ComposerState }) {
	let {
		items,
		results,
		selected,
		query,
		modelMenu,
		filtering,
		openModelMenu,
		completeModelMenu,
		setQuery,
		choose,
		anchor,
		focus,
		keys,
		curModel,
	} = state;
	return (
		<Combobox<Model>
			items={items}
			filteredItems={results}
			value={selected}
			inputValue={query}
			open={modelMenu}
			autoHighlight={filtering}
			itemToStringLabel={item => item.name}
			itemToStringValue={item => item.id}
			isItemEqualToValue={(item, value) => item.id === value.id}
			onOpenChange={openModelMenu}
			onOpenChangeComplete={completeModelMenu}
			onInputValueChange={setQuery}
			onValueChange={choose}
		>
			<div ref={anchor} className="inline-flex min-w-0">
				<ComboboxTrigger
					render={
						<Toolbar.Button
							render={
								<Button
									variant="ghost"
									size="sm"
									className="-ml-0.5 h-6.5 min-w-0 shrink px-2 text-muted-foreground"
								/>
							}
						/>
					}
				>
					<span className="truncate max-inline-[10rem]">
						{selected?.name}
					</span>
				</ComboboxTrigger>
			</div>
			<ComboboxContent
				anchor={anchor}
				align="start"
				sideOffset={6}
				initialFocus={focus}
				finalFocus={false}
				className="w-[18rem] max-w-[calc(100vw-2rem)]"
			>
				<ComboboxInput
					placeholder="Search models"
					autoCorrect="off"
					autoCapitalize="off"
					spellCheck={false}
					showClear
					showTrigger={false}
					className={cn(
						!keys
							&& "has-[[data-slot=input-group-control]:focus-visible]:border-inherit has-[[data-slot=input-group-control]:focus-visible]:ring-0",
					)}
				/>
				<ComboboxEmpty>No models found</ComboboxEmpty>
				<ComboboxList className="scrollbar-muted max-h-56">
					{item => (
						<ComboboxItem
							key={item.id}
							value={item}
							aria-current={item.id === curModel ? "true" : undefined}
							className="group/model pr-7 data-selected:bg-primary data-selected:font-medium data-selected:text-primary-foreground data-selected:**:text-primary-foreground"
						>
							<span className="min-w-0 flex-1 truncate">{item.name}</span>
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}

function ComposerOptions({ state }: { state: ComposerState }) {
	let {
		showMode,
		showAgent,
		showModel,
		selectedAgent,
		terminal,
		onTerminalExpand,
		recording,
		analyser,
		toolbar,
		setToolbar,
		mic,
		voice,
		record,
	} = state;
	return (
		<Composer.Start className="min-w-0">
			<Toolbar.Root
				aria-label="Composer options"
				className="flex min-w-0 items-center gap-0.5"
			>
				{(showMode || showAgent || showModel) && (
					<Toolbar.Group className="flex min-w-0 items-center gap-0.5">
						{showMode && <ComposerMode state={state} />}
						{showAgent && selectedAgent && <ComposerAgent state={state} />}
						{showModel && <ComposerModel state={state} />}
						{showModel && <ComposerEffort state={state} />}
					</Toolbar.Group>
				)}
				{terminal
					? onTerminalExpand && (
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger
									render={
										<Toolbar.Button
											aria-label="Full terminal"
											onClick={onTerminalExpand}
											render={
												<Button
													variant="ghost"
													size="icon-sm"
													className="text-muted-foreground"
												/>
											}
										/>
									}
								>
									<IconConsoleMicro />
								</TooltipTrigger>
								<TooltipContent side="top">Full terminal</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					)
					: recording
					? (
						<div className="flex size-7 items-center justify-center">
							<Waveform analyser={analyser} className="text-muted-foreground" />
						</div>
					)
					: (
						<TooltipProvider>
							{mic && !voice && (
								<Tooltip>
									<TooltipTrigger
										render={
											<Toolbar.Button
												aria-label="Record"
												onClick={record}
												render={
													<Button
														variant="ghost"
														size="icon-sm"
														className="text-muted-foreground"
													/>
												}
											/>
										}
									>
										<IconMicMicro />
									</TooltipTrigger>
									<TooltipContent>Record</TooltipContent>
								</Tooltip>
							)}
							<Tooltip>
								<TooltipTrigger
									render={
										<Toolbar.Button
											aria-label="Formatting tools"
											aria-pressed={toolbar}
											onClick={() => setToolbar(t => !t)}
											render={
												<Button
													variant="ghost"
													size="icon-sm"
													className="text-muted-foreground"
												/>
											}
										/>
									}
								>
									<IconTextMicro />
								</TooltipTrigger>
								<TooltipContent>{toolbar ? "Hide tools" : "Show tools"}</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					)}
			</Toolbar.Root>
		</Composer.Start>
	);
}

function ComposerSend({ state }: { state: ComposerState }) {
	let {
		mic,
		voice,
		busy,
		edit,
		filled,
		ace,
		recording,
		submitBusy,
		submitLabel,
		planning,
		record,
		setRecording,
		send,
		sendable,
		canSend,
	} = state;
	return (
		<Composer.Submit
			empty={voice}
			ready={edit ? filled : filled && !ace}
			recording={mic && recording}
			editing={edit}
			busy={submitBusy}
			busyLabel={submitLabel}
			plan={planning}
			className="relative z-10"
			onRecord={mic ? record : undefined}
			onStop={mic ? () => setRecording(false) : undefined}
			onSend={send}
			disabled={!sendable && (!mic || busy || !canSend)}
			data-beam={ace ? "ace" : undefined}
		/>
	);
}

function ComposerButtons({ state }: { state: ComposerState }) {
	let { terminal, sendable, send, tip, stop, onStop, exit, edit, cancel, accessory } = state;
	return (
		<Composer.End>
			{/* Above the actions' hover halo, which reaches over it. */}
			{accessory && <span className="relative z-10 flex">{accessory}</span>}
			<TooltipProvider>
				{terminal
					? (
						<Composer.Actions
							primary={
								<Tooltip>
									<TooltipTrigger
										render={
											<button
												type="button"
												aria-label="Run"
												disabled={!sendable}
												onClick={send}
												className={cn(
													"relative z-10 flex size-7 items-center justify-center rounded-full! contain-content active:scale-[0.96]",
													"transition-[background-color,color,box-shadow,scale] duration-150",
													"bg-foreground text-background",
												)}
											/>
										}
									>
										<IconArrowUpMicro className="size-4" />
									</TooltipTrigger>
									<TooltipContent>{tip}</TooltipContent>
								</Tooltip>
							}
							secondary={stop
								? (
									<Tooltip>
										<TooltipTrigger render={<Stop onClick={onStop} />} />
										<TooltipContent>Stop response</TooltipContent>
									</Tooltip>
								)
								: (
									<Tooltip>
										<TooltipTrigger
											render={<Cancel aria-label="Exit terminal" onClick={exit} />}
										/>
										<TooltipContent>Exit terminal</TooltipContent>
									</Tooltip>
								)}
						/>
					)
					: (
						<Composer.Actions
							primary={
								<Tooltip>
									<TooltipTrigger
										render={<ComposerSend state={state} />}
									/>
									<TooltipContent>{tip}</TooltipContent>
								</Tooltip>
							}
							secondary={edit
								? (
									<Tooltip>
										<TooltipTrigger render={<Cancel onClick={cancel} />} />
										<TooltipContent>Cancel edit</TooltipContent>
									</Tooltip>
								)
								: stop
								? (
									<Tooltip>
										<TooltipTrigger render={<Stop onClick={onStop} />} />
										<TooltipContent>Stop response</TooltipContent>
									</Tooltip>
								)
								: undefined}
						/>
					)}
			</TooltipProvider>
		</Composer.End>
	);
}

function ComposerLink({ state }: { state: ComposerState }) {
	let { link, closeLink, setLinkState, saveLink, removeLink } = state;
	return (
		<Popover open={link.open} onOpenChange={(open) => !open && closeLink()}>
			<PopoverPortal>
				<PopoverPositioner
					anchor={link.anchor || undefined}
					side="bottom"
					align="start"
					sideOffset={6}
				>
					<PopoverPopup className="w-80 p-3" finalFocus={false}>
						<div className="flex flex-col gap-3">
							<label className="flex flex-col gap-1">
								<span className="text-xs font-medium text-muted-foreground">Link</span>
								<input
									value={link.href}
									onChange={(e) => setLinkState((prev) => ({ ...prev, href: e.target.value }))}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											saveLink();
										}
										if (e.key === "Escape") {
											e.preventDefault();
											closeLink();
										}
									}}
									placeholder="https://example.com"
									className="h-9 rounded-md squircle border border-input bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
								/>
							</label>
							<label className="flex flex-col gap-1">
								<span className="text-xs font-medium text-muted-foreground">Name</span>
								<input
									value={link.name}
									onChange={(e) => setLinkState((prev) => ({ ...prev, name: e.target.value }))}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											saveLink();
										}
										if (e.key === "Escape") {
											e.preventDefault();
											closeLink();
										}
									}}
									placeholder="Link label"
									className="h-9 rounded-md squircle border border-input bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
								/>
							</label>
							<div className="flex justify-end gap-2">
								<button
									type="button"
									onClick={() => closeLink()}
									className="rounded-md squircle px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
								>
									Cancel
								</button>
								<button
									type="button"
									onClick={() => removeLink()}
									className="rounded-md squircle px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
								>
									Remove
								</button>
								<button
									type="button"
									onClick={() => saveLink()}
									className="rounded-md squircle bg-foreground px-2 py-1 text-xs font-medium text-background"
								>
									Apply
								</button>
							</div>
						</div>
					</PopoverPopup>
				</PopoverPositioner>
			</PopoverPortal>
		</Popover>
	);
}

function ComposerEmoji({ state }: { state: ComposerState }) {
	let { emoji, closeEmoji, insertEmoji } = state;
	return (
		<Popover open={emoji.open} onOpenChange={(open) => !open && closeEmoji()}>
			<PopoverPortal>
				<PopoverPositioner
					anchor={emoji.anchor || undefined}
					side="bottom"
					align="start"
					sideOffset={6}
				>
					<PopoverPopup className="overflow-hidden p-0" initialFocus={false} finalFocus={false}>
						<EmojiPicker onSelect={insertEmoji} />
					</PopoverPopup>
				</PopoverPositioner>
			</PopoverPortal>
		</Popover>
	);
}

export {
	type Agent,
	ChatComposer,
	type ChatComposerHandle,
	type Effort,
	type Mode,
	type Model,
	type SendPayload,
};
