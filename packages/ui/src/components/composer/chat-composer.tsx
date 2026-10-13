import { pick } from "../../lib/emoji";
import {
	type ComponentPropsWithRef,
	type ComponentType,
	Fragment,
	type KeyboardEvent,
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

import { useDraft } from "../../hooks/use-draft";
import { useHistory } from "../../hooks/use-history";
import { useMic } from "../../hooks/use-mic";
import { cn } from "../../lib/utils";
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
import { Editor, type Mention } from "./editor";
import { assign, edit as splice, format } from "./format";
import { Preview } from "./preview";
import { canSendMessage } from "./send";
import { useAttachments } from "./use-attachments";
import {
	IconArrowUpMicro,
	IconCheckMicro,
	IconChevronDownMicro,
	IconChevronRightMicro,
	IconConsoleMicro,
	IconEyeMicro,
	IconListTodoMicro,
	IconMessageMicro,
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
	/** Markdown source as written. */
	text: string;
	attachments: Attachment[];
	mode: string;
	model?: string;
	agent?: string;
};

/** Imperative handle exposed via `ref`. */
type ChatComposerHandle = {
	focus: () => void;
	/** Read the current text without changing the editor or its saved draft. */
	get: () => string | undefined;
	clear: () => void;
	set: (text: string) => void;
	insert: (text: string) => void;
};

type Props = {
	/** Storage scope for drafts and recalled messages. Defaults to the current pathname. */
	scope?: string;
	mentions?: Mention[];
	/** Available modes. Defaults to a single "chat" mode. */
	modes?: Mode[];
	/** Available models. Omit to hide the model picker. */
	models?: Model[];
	/** Available agents and execution modes. Omit to hide the agent picker. */
	agents?: Agent[];
	/** Overrides the active mode's placeholder. */
	placeholder?: string;
	/** Enables the microphone + recording UI. Defaults to false. */
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

type EmojiState = {
	open: boolean;
	anchor: HTMLElement | { getBoundingClientRect: () => DOMRect } | null;
};

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

const EMPTY_EMOJI: EmojiState = { open: false, anchor: null };
const IDLE = 5000;
const ESCAPE_WINDOW = 350;

function literal(name: string) {
	return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches `@name` the way the channel recognizes an invocation. */
function mentionPattern(name: string, flags = "i") {
	return new RegExp(`(^|\\s)@${literal(name)}\\b`, flags);
}

function hasMention(text: string, name: string) {
	return mentionPattern(name).test(text);
}

/** Leaving a mention's mode drops its leading mention, the mode's marker, and unlinks the rest. */
function demote(text: string, name: string) {
	let lead = new RegExp(`^\\s*@${literal(name)}\\b ?`, "i");
	return text.replace(lead, "").replace(
		mentionPattern(name, "gi"),
		(match, space: string) => space + match.slice(space.length + 1),
	);
}

/** Entering a mention's mode marks the draft with its mention, adopting a leading bare name. */
function promote(text: string, name: string) {
	let bare = new RegExp(`^(\\s*)(${literal(name)}\\b)`, "i");
	if (bare.test(text)) return text.replace(bare, "$1@$2");
	return `@${name} ${text.trimStart()}`;
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
	let tip = terminal
		? "Run"
		: edit
		? editingRerun ? "Save & rerun" : "Save edit"
		: recording
		? "Stop recording"
		: mic && !busy && empty && !curAttach.length
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
		tip,
	};
}

/** Opinionated chat composer: markdown source with a preview, attachments, mentions, modes,
 * models, and an optional microphone. */
function useComposer({
	scope,
	mentions,
	modes = DEFAULT_MODES,
	models,
	agents,
	placeholder,
	mic = false,
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

	let draft = useDraft(scope);
	let [value, setValue] = useState(draft.defaultValue ?? "");
	let empty = !value;
	let [recording, setRecording] = useState(false);
	let [toolbar, setToolbar] = useState(tools);
	let [preview, setPreview] = useState(false);
	let [modelMenu, setModelMenu] = useState(false);
	let [keys, setKeys] = useState(false);
	let [emoji, setEmoji] = useState<EmojiState>(EMPTY_EMOJI);

	let restoredMode = useRef(draft.defaultValue ? curMode : undefined);
	let history = useHistory(scope);
	let analyser = useMic(mic && recording);

	let input = useRef<HTMLTextAreaElement | null>(null);
	let file = useRef<HTMLInputElement | null>(null);

	let inputs = {
		modes,
		mentions,
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
		let el = input.current;
		if (!el) return;
		let mode = latest.current.modes.find(m => m.id === modeRef.current);
		let mark = mode?.mention && !latest.current.editing ? `@${mode.mention} ` : "";
		assign(el, mark);
		draft.clear();
		type(false);
	}

	function cancel() {
		clear();
		latest.current.onCancelEdit?.();
		input.current?.focus();
	}

	function exit() {
		updateMode(modes[0]!.id);
		input.current?.focus();
	}

	useImperativeHandle(ref, () => ({
		focus: () => input.current?.focus(),
		get: () => input.current?.value,
		clear,
		set: (text: string) => {
			let el = input.current;
			if (!el) return;
			assign(el, text);
			el.focus();
		},
		insert: (text: string) => {
			let el = input.current;
			if (el) splice(el, el.selectionStart, el.selectionEnd, text);
		},
	}));

	// Keep the draft's leading mention in step with the active mode.
	useEffect(() => {
		let el = input.current;
		if (!el || !mentions?.length) return;
		if (latest.current.editing) return;
		// Preserve restored mentions until their inferred mode reaches the controlled prop.
		if (restoredMode.current === curMode) return;
		restoredMode.current = undefined;

		let text = el.value;
		for (let m of modes) {
			if (m.id !== curMode && m.mention) text = demote(text, m.mention);
		}
		let target = modes.find(m => m.id === curMode)?.mention;
		let entry = target ? mentions.find(x => x.name === target) : undefined;
		if (entry && !hasMention(text, entry.name)) text = promote(text, entry.name);
		if (text === el.value) return;
		let tail = el.value.length - el.selectionEnd;
		assign(el, text, Math.max(0, text.length - tail));
	}, [curMode, mentions, modes]);

	function closeEmoji() {
		setEmoji(EMPTY_EMOJI);
	}

	function openEmoji(anchor: HTMLElement | { getBoundingClientRect: () => DOMRect }) {
		setEmoji(prev => prev.open && prev.anchor === anchor ? EMPTY_EMOJI : { open: true, anchor });
	}

	function insertEmoji(item: Emoji) {
		let el = input.current;
		if (el) splice(el, el.selectionStart, el.selectionEnd, pick(item));
		closeEmoji();
	}

	function togglePreview() {
		let next = !preview;
		setPreview(next);
		if (!next) requestAnimationFrame(() => input.current?.focus());
	}

	function send() {
		let el = input.current;
		if (!el) return;
		let text = el.value;
		let sentMode = modeRef.current;
		let mode = latest.current.modes.find(item => item.id === sentMode);
		let attachments = mode?.kind === "terminal" ? [] : attachRef.current;
		if (!canSendMessage({ text, attachments, enabled: canSend })) return;
		type(false);
		latest.current.onSend({
			text,
			attachments,
			mode: sentMode,
			model: modelRef.current,
			agent: agentRef.current,
		});
		history.push(text, sentMode);
		setPreview(false);
		if (clearOnSend) {
			clear();
			resetAttach();
		}
		el.focus();
	}

	function action(event: ComposerToolbarEvent) {
		if (event.action === "attach") {
			if (attachable) file.current?.click();
			return;
		}
		if (event.action === "emoji") return openEmoji(event.trigger);
		let el = input.current;
		if (el) format(el, event.action);
	}

	/** The draft without the active mode's leading mention: what the person has written. */
	function own(text: string) {
		let mention = latest.current.modes.find(m => m.id === modeRef.current)?.mention;
		return mention ? demote(text, mention) : text;
	}

	function change(text: string) {
		draft.save(text);
		history.reset();
		let typed = Boolean(own(text).trim());
		type(typed, typed);
		setValue(text);
		latest.current.onTextChange?.(text);
		infer(text);
	}

	/** A mention typed or removed by hand switches to or from its mode. */
	function infer(text: string) {
		let ms = latest.current.modes;
		if (!latest.current.mentions?.length) return;
		for (let m of ms) {
			if (m.mention && hasMention(text, m.mention) && modeRef.current !== m.id) {
				return updateMode(m.id);
			}
		}
		let cur = ms.find(m => m.id === modeRef.current);
		if (cur?.mention && !hasMention(text, cur.mention)) updateMode(ms[0]!.id);
	}

	useEffect(() => {
		if (!draft.defaultValue) return;
		latest.current.onTextChange?.(draft.defaultValue);
		infer(draft.defaultValue);
	}, []);

	function keydown(e: KeyboardEvent<HTMLElement>) {
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p" && !terminal) {
			e.preventDefault();
			togglePreview();
			return true;
		}
		let el = input.current;
		let ms = latest.current.modes;
		if (!el || !ms.length || e.target !== el) return false;
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
				updateMode(ms[0]!.id);
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
		}
		if (e.key === "!" && !e.metaKey && !e.ctrlKey && !el.value) {
			let term = ms.find(m => m.kind === "terminal");
			if (term && modeRef.current !== term.id) {
				e.preventDefault();
				updateMode(term.id);
				return true;
			}
		}
		let blank = !own(el.value).trim();
		return history.handleKey(el, e, blank, m => updateMode(m || ms[0]!.id));
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
		file,
		input,
		draft,
		change,
		keydown,
		preview,
		togglePreview,
		value,
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
		setRecording,
		cancel,
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
		action,
		input,
		draft,
		mentions,
		change,
		keydown,
		preview,
		value,
		send,
		placeholder,
		cwd,
		current,
	} = state;
	let previewing = preview && !terminal;
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
				<Composer.Header open={toolbar && !terminal && !previewing}>
					<ComposerToolbar disabled={{ attach: !attachable }} onAction={action} />
				</Composer.Header>
				<Composer.Input data-mode={terminal ? "terminal" : undefined}>
					{terminal && (
						<div className="pointer-events-none mt-3 flex h-[calc(0.8125rem*1.5)] shrink-0 items-center pl-3 text-muted-foreground">
							<IconChevronRightMicro className="size-3.5" />
						</div>
					)}
					<Editor
						ref={input}
						aria-label="Message"
						defaultValue={draft.defaultValue}
						mentions={mentions}
						onChange={change}
						onKeyDown={keydown}
						onSubmit={send}
						onFiles={attachable ? addFiles : undefined}
						placeholder={placeholder ?? (terminal && cwd ? cwd : current?.placeholder)}
						hidden={previewing}
						className="text-sm text-foreground"
					/>
					{previewing && (
						<Preview
							raw={value}
							mentions={mentions}
							onKeyDown={keydown}
							className="text-sm text-foreground outline-none"
						/>
					)}
				</Composer.Input>
				<Composer.Footer>
					<ComposerOptions state={state} />
					<ComposerButtons state={state} />
				</Composer.Footer>
			</Composer.Body>
			<ComposerEmoji state={state} />
		</Composer>
	);
}

function ComposerMode({ state }: { state: ComposerState }) {
	let { edit, CurrentIcon, current, modes, updateMode, input } = state;
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
								input.current?.focus();
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
	let { AgentIcon, selectedAgent, agents, updateAgent, input, curAgent } = state;
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
			<DropdownMenuContent align="start" sideOffset={6} className="min-w-56">
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
									input.current?.focus();
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
	let { efforts, effort, onEffortChange, input } = state;
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
								input.current?.focus();
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
									className="-ml-0.5 h-6.5 px-2 text-muted-foreground"
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
		preview,
		togglePreview,
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
							<Tooltip>
								<TooltipTrigger
									render={
										<Toolbar.Button
											aria-label="Preview"
											aria-pressed={preview}
											onClick={togglePreview}
											render={
												<Button
													variant="ghost"
													size="icon-sm"
													className="text-muted-foreground aria-pressed:text-foreground"
												/>
											}
										/>
									}
								>
									<IconEyeMicro />
								</TooltipTrigger>
								<TooltipContent>
									{preview ? "Edit" : "Preview"} <span className="text-muted-foreground">⇧⌘P</span>
								</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger
									render={
										<Toolbar.Button
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
		busy,
		empty,
		curAttach,
		edit,
		filled,
		ace,
		recording,
		submitBusy,
		planning,
		setRecording,
		send,
		sendable,
		canSend,
	} = state;
	return (
		<Composer.Submit
			empty={mic && !busy && empty && !curAttach.length}
			ready={edit ? filled : filled && !ace}
			recording={mic && recording}
			editing={edit}
			busy={submitBusy}
			plan={planning}
			className="relative z-10"
			onRecord={mic
				? () => setRecording(true)
				: undefined}
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
			{accessory}
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
