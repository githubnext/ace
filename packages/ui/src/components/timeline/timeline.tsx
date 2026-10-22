import {
	type ComponentPropsWithRef,
	type CSSProperties,
	Fragment,
	type MouseEvent,
	type PointerEvent,
	type ReactNode,
	type Ref,
	useCallback,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Event, REPO } from "../../types";

import { AceAvatar } from "../ace-avatar/ace-avatar";
import {
	type ExecAction,
	type ExecActionPayload,
	ExecActionProvider,
	type Mention,
	ToolProvider,
} from "../blocks";
import { fonts as blockFonts } from "../blocks/parse";
import {
	MessageToolbar,
	type MessageToolbarAction,
	type MessageToolbarProps,
} from "../message-toolbar/message-toolbar";
import { Reactions } from "../reactions/reactions";
import type { DocumentCandidate } from "../rich-text/references";
import {
	ScrollView,
	type ScrollViewHandle,
	type ScrollViewRange,
} from "../scroll-view/scroll-view";
import { TurnSummary } from "../turn-summary/turn-summary";
import type { Block } from "../../lib/block";
import { iconFor } from "../../lib/tool-icon";
import { agentColor, agentLabel } from "../../lib/agent";
import { cn } from "../../lib/utils";
import {
	type AgentTurn,
	compile,
	type Group,
	isCommentChunk,
	type Row,
	type TimelineItem,
	type TimelineWorking,
	type WorkingItem,
} from "../../lib/timeline";

import {
	AVATAR,
	AVATAR_GAP,
	AVATAR_NUDGE,
	BUBBLE_BORDER,
	BUBBLE_GAP,
	BUBBLE_PAD_X,
	BUBBLE_PAD_Y,
	BYLINE_HEIGHT,
	CONTENT_GAP,
	DAY_HEIGHT,
	GAP,
	HEADER_GAP,
	itemHeight,
	LANE,
	measureRow,
	PAD,
	PR_COMMENT_BODY_GAP,
	PR_COMMENT_BUBBLE_PAD_BOTTOM,
	PR_COMMENT_GAP,
	REACTION_GAP,
	summaryId,
	TAIL,
	TOOL_GROUP_PAD_Y,
	TOOL_GROUP_ROW_HEIGHT,
	TOOL_LIST_INDENT,
	TURN_GAP,
	useBlockMap,
	WORKING_SUMMARY_HEIGHT,
	WORKING_SUMMARY_PAD_END,
} from "./layout";
import {
	IconChevronDownMicro,
	IconCommit,
	IconEnter,
	IconExit,
	IconMessage,
	IconPullRequest,
	IconRecord,
	IconTerminal,
} from "../../icons";

import "./timeline.css";

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const exactFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const workingTextFonts = blockFonts();
const workingTextFont = {
	font: workingTextFonts.font,
	lineHeight: `${workingTextFonts.lineHeight}px`,
};
const dateFmt = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	month: "short",
	day: "numeric",
});
const dateYearFmt = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	month: "short",
	day: "numeric",
	year: "numeric",
});
const introDateFmt = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
});
let ids = new WeakMap<Block, string>();
let seq = 0;
/** How far the floating toolbar overlaps the top edge of the message bubble. */
const OVERLAP = 10;
const TOOLBAR_HEIGHT = 26;
/** Sticky top offset for long Ace turns — matches the avatar's `sticky top-3`. */
const STICKY_TOP = 12;
const VIEWPORT_PAD = 8;
/** Horizontal protrusion of the toolbar beyond the bubble's outer edge. */
const OFFSET = 14;
const WORKING_ROLLUP_MS = 180;
const CODE_OUTSET = BUBBLE_PAD_X - BUBBLE_PAD_Y;

type Style = CSSProperties & { "--code-outset"?: string };

/** Format a day-divider label using Intl.RelativeTimeFormat, falling back to an absolute date past a week. */
function dayLabel(ts: number): string {
	let day = new Date(ts * 1000);
	let now = new Date();
	let today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	let diff = Math.round((today - day.getTime()) / 86400000);
	if (diff < 7) {
		let rel = rtf.format(-diff, "day");
		return rel[0]!.toUpperCase() + rel.slice(1);
	}
	if (day.getFullYear() === now.getFullYear()) return dateFmt.format(day);
	return dateYearFmt.format(day);
}

type TimelineIntro = {
	name: string;
	createdAt: number;
	owner?: string;
};

type TimelineVisibility = {
	pinned: boolean;
	messages: string[];
};
type TimelineExecAction = ExecAction;
type TimelineExec = ExecActionPayload;

type EventRow = Extract<TimelineItem, { kind: "event" }>["row"];
type EventIcon = typeof IconCommit;

function introLabel(intro: TimelineIntro): string {
	let name = intro.name.trim();
	let title = name ? name.startsWith("#") ? name : `#${name}` : "This";
	let date = introDateFmt.format(new Date(intro.createdAt * 1000));
	return `${title} channel was created on ${date}${intro.owner ? ` by ${intro.owner}` : ""}`;
}

// -- Rendering --

/** Render a list of blocks at a given width. */
function BlockList({ blocks, width }: { blocks: Block[]; width: number }) {
	return <>{blocks.map(b => <Fragment key={key(b)}>{b.render(width)}</Fragment>)}</>;
}

function key(block: Block) {
	if (block.key) return block.key;
	let id = ids.get(block);
	if (!id) {
		id = String(++seq);
		ids.set(block, id);
	}
	return id;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function FloatingToolbar(
	{
		align,
		actions,
		canEdit,
		mine,
		onAction,
		onOpenChange,
		sticky,
		width,
	}: {
		align: "left" | "right";
		actions?: MessageToolbarProps["actions"];
		canEdit: boolean;
		mine: boolean;
		onAction: (action: MessageToolbarAction) => void;
		onOpenChange?: (open: boolean) => void;
		sticky?: boolean;
		width: number;
	},
) {
	let frame = useRef<HTMLDivElement | null>(null);
	let bar = useRef<HTMLDivElement | null>(null);
	let [shift, setShift] = useState(0);

	// Positioning-only: this measures viewport/lane bounds to clamp the floating toolbar
	// horizontally. It does not contribute to row height — the toolbar is absolute/sticky
	// with `pointer-events-none`, fully outside the measured timeline layout.
	useLayoutEffect(() => {
		let root = frame.current;
		let toolbar = bar.current;
		if (!root || !toolbar) return;

		let viewport = root.closest<HTMLElement>("[data-slot='scroll-view']");
		let lane = root.closest<HTMLElement>("[data-message-lane]");

		let update = () => {
			let vp = viewport?.getBoundingClientRect();
			let lb = lane?.getBoundingClientRect();
			let rect = root.getBoundingClientRect();
			let size = toolbar.getBoundingClientRect().width;
			let left = align === "right" ? rect.right - size : rect.left;
			let min = Math.max((vp?.left ?? 0) + VIEWPORT_PAD, lb?.left ?? 0);
			let end = Math.min(
				(vp?.right ?? window.innerWidth) - VIEWPORT_PAD,
				lb?.right ?? window.innerWidth,
			);
			let max = Math.max(min, end - size);
			let next = Math.round(clamp(left, min, max) - left);
			setShift(prev => prev === next ? prev : next);
		};

		update();
		let observer = new ResizeObserver(update);
		observer.observe(root);
		observer.observe(toolbar);
		window.addEventListener("resize", update);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", update);
		};
	}, [align, sticky, width]);

	let right = align === "right";
	let transform = [
		shift ? `translateX(${shift}px)` : "",
		sticky ? `translateY(calc(-100% + ${OVERLAP}px))` : "",
	].filter(Boolean).join(" ") || undefined;

	return (
		<div
			ref={frame}
			className={cn(
				"z-20 flex pointer-events-none",
				sticky ? "sticky" : "absolute",
				right ? "right-0 justify-end" : "left-0 justify-start",
			)}
			style={{
				inlineSize: width,
				[right ? "insetInlineEnd" : "insetInlineStart"]: -OFFSET,
				...(sticky
					? {
						blockSize: TOOLBAR_HEIGHT,
						marginBlockEnd: -TOOLBAR_HEIGHT,
						top: STICKY_TOP + TOOLBAR_HEIGHT - OVERLAP,
					}
					: { bottom: `calc(100% - ${OVERLAP}px)` }),
			}}
		>
			<MessageToolbar
				ref={bar}
				align={align}
				actions={actions}
				canEdit={canEdit}
				mine={mine}
				onAction={onAction}
				onOpenChange={onOpenChange}
				style={transform ? { transform } : undefined}
			/>
		</div>
	);
}

function AgentWorkingItemView(
	{
		item,
		blocks,
		width,
		open,
		expanded,
		onToggle,
		live,
		index,
	}: {
		item: WorkingItem;
		blocks: Map<string, Block[]>;
		width: number;
		open: boolean;
		expanded: boolean;
		onToggle: (id: string) => void;
		live: boolean;
		index: number;
	},
) {
	let b = blocks.get(item.id) || [];
	let delay = live ? `${Math.min(index, 4) * 45}ms` : undefined;
	if (item.type === "text") {
		return (
			<div
				className={cn("flex flex-col", live && "timeline-stream-in")}
				style={{ gap: CONTENT_GAP, animationDelay: delay }}
			>
				<BlockList blocks={b} width={width} />
			</div>
		);
	}

	let first = item.tools[0];
	let icon = first?.agent?.kind === "subagent" || first?.name === "task"
		? "subagent"
		: first?.name || "tool";
	let Icon = iconFor(/^view(file)?$/i.test(icon) ? "read" : icon);
	let panel = `${item.id}-tools`;
	let running = item.tools.some(tool => tool.status === "start" || tool.status === "pending");
	let label = item.caption ? `${item.caption}${running ? "…" : ""}` : item.summary;
	return (
		<div
			className={cn("flex min-w-0 flex-col", live && "timeline-stream-in")}
			style={{ gap: CONTENT_GAP, paddingBlock: TOOL_GROUP_PAD_Y, animationDelay: delay }}
		>
			<button
				type="button"
				onClick={() => onToggle(item.id)}
				data-state={expanded ? "open" : "closed"}
				aria-expanded={expanded}
				aria-controls={panel}
				className="flex min-w-0 items-center gap-1.5 self-start overflow-hidden rounded-md pr-1.5 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
				style={{ blockSize: TOOL_GROUP_ROW_HEIGHT, maxInlineSize: "100%", ...workingTextFont }}
			>
				<Icon className="size-4 shrink-0" />
				<span className="min-w-0 truncate">{label}</span>
				{item.caption && (
					<span className="shrink-0 text-xs text-muted-foreground/70">{item.summary}</span>
				)}
				<IconChevronDownMicro
					className={cn(
						"size-3 shrink-0 origin-center rotate-0 transition-[rotate] duration-200 ease-out motion-reduce:transition-none",
						!expanded && "-rotate-90",
					)}
				/>
			</button>
			{open && (
				<div
					id={panel}
					role="region"
					aria-label={item.caption || item.summary}
					className="timeline-tools-expand-in flex min-w-0 flex-col"
					style={{ gap: CONTENT_GAP, paddingInlineStart: TOOL_LIST_INDENT }}
				>
					<BlockList blocks={b} width={width - TOOL_LIST_INDENT} />
				</div>
			)}
		</div>
	);
}

function workingClass(collapsed: boolean, open: boolean, settling: boolean) {
	return cn(
		"flex min-w-0 flex-col rounded-2xl squircle border border-border",
		collapsed && "text-muted-foreground transition-colors duration-150",
		collapsed && !open && "hover:bg-muted/60 hover:text-foreground",
		collapsed && open && !settling && "timeline-working-context-open",
		collapsed && settling && "timeline-working-context-closing",
	);
}

function AgentWorkingContextView(
	{
		turn,
		blocks,
		width,
		open,
		expanded,
		settling,
		groupId,
		openGroups,
		onToggle,
		onToggleGroup,
	}: {
		turn: AgentTurn;
		blocks: Map<string, Block[]>;
		width: number;
		open: boolean;
		expanded: boolean;
		settling: boolean;
		groupId: string;
		openGroups: Set<string>;
		onToggle: (id: string) => void;
		onToggleGroup: (id: string) => void;
	},
) {
	let collapsed = !!turn.final;
	let live = !collapsed;
	let panel = `${groupId}-working`;

	return (
		<div
			className={workingClass(collapsed, open, settling)}
			style={{
				gap: CONTENT_GAP,
				paddingBlock: BUBBLE_PAD_Y,
				paddingInline: BUBBLE_PAD_X - BUBBLE_BORDER,
			}}
		>
			{collapsed && (
				<button
					type="button"
					onClick={() => onToggle(groupId)}
					aria-expanded={expanded}
					aria-controls={panel}
					className="flex min-w-0 flex-col overflow-hidden rounded-md text-left text-sm"
					style={{
						maxInlineSize: "100%",
						paddingInlineEnd: WORKING_SUMMARY_PAD_END,
						...workingTextFont,
					}}
				>
					{turn.recap && <span className="text-foreground/80">{codeSpans(turn.recap)}</span>}
					<span
						className={cn("flex min-w-0 items-center gap-1.5", turn.recap && "text-xs")}
						style={{ blockSize: WORKING_SUMMARY_HEIGHT }}
					>
						<span className="min-w-0 truncate">{turn.summary}</span>
						<IconChevronDownMicro
							className={cn(
								"size-3 shrink-0 origin-center rotate-0 transition-[rotate] duration-200 ease-out motion-reduce:transition-none",
								!expanded && "-rotate-90",
							)}
						/>
					</span>
				</button>
			)}
			{open && (
				<div
					id={panel}
					role={collapsed ? "region" : undefined}
					aria-label={collapsed ? turn.recap || turn.summary : undefined}
					className={cn(
						"flex min-w-0 flex-col",
						collapsed && (settling ? "timeline-working-rollup-out" : "timeline-working-rollup-in"),
					)}
					style={{ gap: CONTENT_GAP }}
				>
					{turn.working.map((w, index) => {
						let open = w.type === "tools" && openGroups.has(w.id);
						return (
							<AgentWorkingItemView
								key={w.id}
								item={w}
								blocks={blocks}
								width={width}
								open={open}
								expanded={open}
								onToggle={onToggleGroup}
								live={live}
								index={index}
							/>
						);
					})}
				</div>
			)}
		</div>
	);
}

/** Recaps are plain text, but models still wrap commands and paths in backticks. */
function codeSpans(text: string) {
	return text.split(/`([^`]+)`/).map((part, i) =>
		i % 2 ? <code key={i} className="font-mono text-[0.92em]">{part}</code> : part
	);
}

function find(items: TimelineItem[], uid: string) {
	for (let i = 0; i < items.length; i++) {
		let item = items[i]!;
		if (item.kind === "event" && item.row.uid === uid) return i;
		if (item.kind === "group" && item.group.rows.some(row => row.uid === uid)) return i;
	}
	return -1;
}

function finalWorkingIds(items: TimelineItem[]): string[] {
	let ids: string[] = [];
	for (let item of items) {
		if (item.kind !== "group") continue;
		if (item.turn?.final && item.turn.working.length) ids.push(item.group.id);
	}
	return ids;
}

function EventBlockList({ blocks, row, width }: { blocks: Block[]; row: Row; width: number }) {
	if (isPrCommentEvent(row, blocks)) {
		return <PrCommentEvent blocks={blocks} width={width} />;
	}

	return (
		<div className="flex min-w-0 flex-col" style={{ gap: CONTENT_GAP }}>
			<RenderedBlocks blocks={blocks} width={width} />
		</div>
	);
}

function isPrCommentEvent(row: Row, blocks: Block[]): boolean {
	return isCommentChunk(row.chunks[0]?.kind) && blocks.length > 1;
}

function PrCommentEvent({ blocks, width }: { blocks: Block[]; width: number }) {
	let [head, ...body] = blocks;
	let inner = width - BUBBLE_PAD_X * 2;

	return (
		<div className="flex min-w-0 flex-col" style={{ gap: PR_COMMENT_GAP }}>
			{head && <Fragment key={key(head)}>{head.render(width)}</Fragment>}
			<div
				className="rounded-2xl squircle bg-muted"
				style={{
					"--code-outset": `${CODE_OUTSET}px`,
					paddingBlockStart: BUBBLE_PAD_Y,
					paddingBlockEnd: PR_COMMENT_BUBBLE_PAD_BOTTOM,
					paddingInline: BUBBLE_PAD_X,
				} as Style}
			>
				<div className="flex min-w-0 flex-col" style={{ gap: PR_COMMENT_BODY_GAP }}>
					<RenderedBlocks blocks={body} width={inner} />
				</div>
			</div>
		</div>
	);
}

function RenderedBlocks({ blocks, width }: { blocks: Block[]; width: number }) {
	return <>{blocks.map(b => <Fragment key={key(b)}>{b.render(width)}</Fragment>)}</>;
}

function EventGlyph({ row }: { row: EventRow }) {
	let Icon = eventIcon(row);

	return (
		<div
			className="grid shrink-0 place-items-center rounded-full border border-border"
			style={{ inlineSize: AVATAR, blockSize: AVATAR, marginBlockStart: AVATAR_NUDGE }}
		>
			<Icon className="size-4 text-muted-foreground" aria-hidden />
		</div>
	);
}

function eventIcon(row: EventRow): EventIcon {
	let chunk = row.chunks[0];

	switch (chunk?.kind) {
		case "exec":
			return IconTerminal;
		case "presence":
			return chunk.action === "join" ? IconEnter : IconExit;
		case "pr-comment":
		case "pr-review":
		case "pr-review-comment":
		case "issue-comment":
			return IconMessage;
		case "issue":
		case "issue-update":
			return IconRecord;
		case "pr":
		case "pr-update":
			return IconPullRequest;
		default:
			return IconCommit;
	}
}

/** Render a message group with sticky avatar and block-based content. */
type GroupProps = {
	group: Group;
	actions?: TimelineProps["actions"];
	turn?: AgentTurn;
	blocks: Map<string, Block[]>;
	width: number;
	loading: boolean;
	avatars?: Record<string, string>;
	currentUser?: Event.Viewer;
	alignment: "left" | "right";
	target?: string;
	editing?: string;
	unsent?: ReadonlyMap<string, Unsent>;
	editable?: ReadonlySet<string>;
	mentioned?: ReadonlySet<string>;
	openGroups: Set<string>;
	openWorking: Set<string>;
	settlingWorking: Set<string>;
	onToggleWorking: (id: string) => void;
	onToggleGroup: (id: string) => void;
	onRowEnter?: (uid: string) => void;
	onRowLeave?: () => void;
	onReact?: (uid: string, emoji: string) => void;
	onLink?: (href: string) => void;
	openSender?: TimelineProps["openSender"];
	onFileOpen?: (file: string) => void;
	onDiffFileOpen?: (file: string) => void;
	onReviewChanges?: () => void;
	hover?: string | null;
	onToolbarAction?: (uid: string, action: MessageToolbarAction) => void;
	onOpenChange?: (open: boolean) => void;
};

function frame(
	{
		group,
		turn,
		width,
		currentUser,
		alignment,
		avatars,
		hover,
		openWorking,
		settlingWorking,
		openSender,
	}: GroupProps,
) {
	let content = width - PAD * 2 - AVATAR - AVATAR_GAP;
	let text = content - BUBBLE_PAD_X * 2;
	let workingExpanded = !!turn && (!turn.final || openWorking.has(group.id));
	let workingOpen = workingExpanded || settlingWorking.has(group.id);
	let workingSettling = settlingWorking.has(group.id);
	let label = group.role === "user"
		? group.display || String(group.sender || "User")
		: group.display || (group.run ? "Ace" : "ace");
	let name = label;
	let credit = group.credit;
	let open = group.role === "user" && group.sender != null
		? openSender?.(String(group.sender))
		: undefined;
	let hasByline = group.rows.length > 0;
	let own = !!currentUser && group.role === "user"
		&& (currentUser.own
			? currentUser.own.includes(String(group.sender))
			: group.sender === currentUser.id || group.display === currentUser.login);
	let mine = alignment === "right" && own;
	let src = group.display && avatars?.[group.display]
		|| (group.sender != null ? avatars?.[String(group.sender)] : undefined);

	let uid = turn?.final?.uid || group.rows.at(-1)?.uid;
	let active =
		hover && (turn ? turn.final?.uid === hover : group.rows.some(row => row.uid === hover))
			? hover
			: null;
	let meta = active
		? group.rows.find(row => row.uid === active) ?? turn?.final
		: group.rows.at(-1) ?? turn?.final;
	// Unhovered, the byline speaks for every message in the group, so any edit marks it.
	let edited = active
		? meta?.edited
		: [...group.rows, turn?.final].reduce<number | undefined>(
			(at, row) => row?.edited && row.edited > (at ?? 0) ? row.edited : at,
			undefined,
		);
	let stamp = meta?.ts ?? group.ts;
	let date = timeFmt.format(stamp * 1000);
	let title = exactFmt.format(stamp * 1000);
	let edit = edited && (active ? `edited ${exactFmt.format(edited * 1000)}` : "edited");
	let editTitle = edited ? exactFmt.format(edited * 1000) : undefined;
	let selection = meta?.agent;
	let agent = agentLabel(selection);
	let tone = agentColor(selection);
	return {
		content,
		text,
		workingExpanded,
		workingOpen,
		workingSettling,
		label,
		name,
		credit,
		open,
		hasByline,
		own,
		mine,
		src,
		uid,
		active,
		date,
		title,
		edit,
		editTitle,
		agent,
		tone,
	};
}

/** Delivery state of an own message that the server has not acknowledged. */
type Unsent = "pending" | "failed";

type GroupState = ReturnType<typeof frame>;
type GroupRender = { props: GroupProps; state: GroupState };
type RowToolbar = (id: string, fit: number, sticky?: boolean) => ReactNode;

function GroupView(props: GroupProps) {
	let { turn, onRowEnter, onRowLeave, editable, onToolbarAction, onOpenChange } = props;
	let state = frame(props);
	let { uid, active, own, mine } = state;
	let enter = uid && onRowEnter
		? ((e: MouseEvent<HTMLElement>) => {
			let target = e.target;
			let node = target instanceof Element
				? target.closest<HTMLElement>("[data-message-id]")
				: null;
			onRowEnter(node?.dataset.messageId || uid);
		})
		: undefined;
	let toolbar = (id: string, fit: number, sticky?: boolean) =>
		active === id && (
			<FloatingToolbar
				align={mine ? "left" : "right"}
				actions={typeof props.actions === "function" ? props.actions(id) : props.actions}
				mine={own}
				canEdit={own && !!editable?.has(id)}
				sticky={sticky}
				width={fit}
				onAction={(action) => onToolbarAction?.(id, action)}
				onOpenChange={onOpenChange}
			/>
		);

	return (
		<div
			data-hover-message-id={uid}
			className={cn("flex h-full", mine && "flex-row-reverse")}
			style={{ gap: AVATAR_GAP, paddingInline: PAD }}
			onMouseEnter={enter}
			onMouseLeave={onRowLeave}
		>
			<GroupAvatar props={props} state={state} />

			<div data-message-lane className="flex-1 min-w-0 flex flex-col" style={{ gap: CONTENT_GAP }}>
				<GroupByline state={state} />

				{turn
					? <GroupTurn props={props} state={state} toolbar={toolbar} />
					: <GroupRows props={props} state={state} toolbar={toolbar} />}
			</div>
		</div>
	);
}

function GroupAvatar({ props, state }: GroupRender) {
	let { group, loading } = props;
	let { src, label } = state;
	return (
		<div className="shrink-0">
			{group.role === "assistant"
				? (
					<div
						className="rounded-full sticky top-3"
						style={{ inlineSize: AVATAR, blockSize: AVATAR, marginBlockStart: AVATAR_NUDGE }}
					>
						<AceAvatar className="rounded-full" loading={loading} />
					</div>
				)
				: src
				? (
					<span
						className="block rounded-full sticky top-3 overflow-hidden bg-black/5 dark:bg-white/[0.03]"
						style={{ inlineSize: AVATAR, blockSize: AVATAR, marginBlockStart: AVATAR_NUDGE }}
					>
						<img
							src={src}
							alt={label}
							className="size-full rounded-full object-cover"
						/>
						<span
							className="pointer-events-none absolute inset-0 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.22)]"
							aria-hidden
						/>
					</span>
				)
				: (
					<div
						className="rounded-full sticky top-3"
						style={{
							inlineSize: AVATAR,
							blockSize: AVATAR,
							marginBlockStart: AVATAR_NUDGE,
							background: "var(--primary)",
						}}
					/>
				)}
		</div>
	);
}

function GroupByline({ state }: { state: GroupState }) {
	let { hasByline, mine, name, credit, open, agent, tone, title, date, edit, editTitle } = state;
	return (
		<>
			{hasByline && (
				<div
					className={cn(
						"flex min-w-0 items-baseline gap-1.5 overflow-hidden text-xs text-muted-foreground",
						mine && "flex-row-reverse justify-start text-right",
					)}
					style={{
						blockSize: BYLINE_HEIGHT,
						marginBlockEnd: HEADER_GAP - CONTENT_GAP,
						paddingInlineStart: mine ? 0 : 4,
						paddingInlineEnd: mine ? 4 : 0,
					}}
				>
					{open
						? (
							<button
								type="button"
								className="min-w-0 truncate font-medium text-foreground hover:underline"
								title={name}
								onClick={open}
							>
								{name}
							</button>
						)
						: (
							<span className="min-w-0 truncate font-medium text-foreground" title={name}>
								{name}
							</span>
						)}
					{credit && (
						<span className="min-w-0 truncate text-[0.625rem]" title={credit}>
							{credit}
						</span>
					)}
					{agent && (
						<span
							className="min-w-0 truncate text-[0.625rem] font-medium"
							style={{ color: tone }}
							title={agent}
						>
							{agent}
						</span>
					)}
					<span className="shrink-0 text-[0.625rem]" title={title}>
						{date}
					</span>
					{edit && <span className="shrink-0 text-[0.625rem]" title={editTitle}>{edit}</span>}
				</div>
			)}
		</>
	);
}

function GroupTurn({ props, state, toolbar }: GroupRender & { toolbar: RowToolbar }) {
	let {
		turn,
		group,
		blocks,
		openGroups,
		onToggleWorking,
		onToggleGroup,
		onRowEnter,
		currentUser,
		onReact,
		onOpenChange,
		onFileOpen,
		onDiffFileOpen,
		onLink,
		onReviewChanges,
	} = props;
	let { text, content, workingOpen, workingExpanded, workingSettling } = state;
	if (!turn) return null;
	return (
		<div className="relative">
			<div className="flex flex-col" style={{ gap: TURN_GAP }}>
				{turn.working.length > 0 && (
					<AgentWorkingContextView
						turn={turn}
						blocks={blocks}
						width={text}
						open={workingOpen}
						expanded={workingExpanded}
						settling={workingSettling}
						groupId={group.id}
						openGroups={openGroups}
						onToggle={onToggleWorking}
						onToggleGroup={onToggleGroup}
					/>
				)}

				{turn.final && (
					<div
						data-message-id={turn.final.uid}
						className="group/final relative"
						onMouseEnter={onRowEnter && (() => onRowEnter(turn.final!.uid))}
					>
						{toolbar(turn.final.uid, content, true)}
						<div className="flex flex-col" style={{ gap: REACTION_GAP }}>
							<div
								className="rounded-2xl squircle bg-muted"
								style={{
									"--code-outset": `${CODE_OUTSET}px`,
									padding: `${BUBBLE_PAD_Y}px ${BUBBLE_PAD_X}px`,
								} as Style}
							>
								<BlockList
									blocks={blocks.get(turn.final.uid) || []}
									width={content - BUBBLE_PAD_X * 2}
								/>
							</div>
							{turn.final.reactions && turn.final.reactions.length > 0 && (
								<Reactions
									reactions={turn.final.reactions}
									currentUser={currentUser}
									onReact={onReact && ((emoji) => onReact(turn.final!.uid, emoji))}
									onOpenChange={onOpenChange}
								/>
							)}
						</div>
					</div>
				)}

				{(turn.artifacts.length > 0 || turn.files.length > 0) && (
					<TurnSummary
						id={group.id}
						artifacts={turn.artifacts}
						files={turn.files}
						artifactsExpanded={openGroups.has(summaryId(group.id, "artifacts"))}
						filesExpanded={openGroups.has(summaryId(group.id, "files"))}
						onToggleArtifacts={() => onToggleGroup(summaryId(group.id, "artifacts"))}
						onToggleFiles={() => onToggleGroup(summaryId(group.id, "files"))}
						onFileOpen={onFileOpen}
						onEditedFileOpen={onDiffFileOpen}
						onLink={onLink}
						onReviewChanges={onReviewChanges}
					/>
				)}
			</div>
		</div>
	);
}

function GroupRows({ props, state, toolbar }: GroupRender & { toolbar: RowToolbar }) {
	let {
		group,
		blocks,
		editing,
		unsent,
		mentioned,
		target,
		onRowEnter,
		currentUser,
		onReact,
		onOpenChange,
	} = props;
	let { content, mine } = state;

	let isUser = group.role === "user";
	let isBubble = isUser || group.role === "assistant";
	let inner = isBubble ? content - BUBBLE_PAD_X * 2 : content;
	let entries = group.rows.map(row => {
		let b = blocks.get(row.uid) || [];
		return {
			b,
			agent: row.agent,
			// An unbreakable token wider than the lane must not widen the bubble past it.
			fit: isBubble ? Math.min(measureRow(b, inner).fit, inner) : inner,
			reactions: row.reactions,
			uid: row.uid,
		};
	});
	let broke = (j: number) => {
		let p = entries[j - 1];
		let e = entries[j];
		let n = entries[j + 1];
		return !!(p && n && e && e.fit < p.fit && e.fit < n.fit);
	};
	return (
		<div
			className={cn("flex flex-col", mine && "items-end")}
			style={{ gap: isUser ? BUBBLE_GAP : CONTENT_GAP }}
		>
			{entries.map(({ b, agent, fit, reactions, uid }, i) => {
				let prev = entries[i - 1];
				let next = entries[i + 1];
				let last = i === entries.length - 1;
				let self = broke(i);
				let above = broke(i - 1);
				let below = broke(i + 1);
				let hasReact = !!reactions?.length;
				let prevHasReact = !!prev?.reactions?.length;
				let edit = editing === uid;
				let state = unsent?.get(uid);
				let wide = isBubble ? fit + BUBBLE_PAD_X * 2 : fit;
				let tone = agentColor(agent);
				let label = agentLabel(agent);
				return (
					<div
						key={uid}
						data-message-id={uid}
						className={cn("relative flex flex-col", mine && "items-end")}
						style={{
							gap: REACTION_GAP,
							inlineSize: isBubble ? wide : undefined,
							maxInlineSize: isBubble ? "100%" : undefined,
						}}
						onMouseEnter={onRowEnter && (() => onRowEnter(uid))}
					>
						{toolbar(uid, wide)}
						<div
							className={cn(
								"rounded-2xl squircle",
								prev && !prevHasReact && (mine ? "rounded-tr-none" : "rounded-tl-none"),
								prev && !self && !above && fit <= prev.fit && !prevHasReact
									&& (mine ? "rounded-tl-none" : "rounded-tr-none"),
								next && !hasReact && (mine ? "rounded-br-none" : "rounded-bl-none"),
								next && !self && !below && fit <= next.fit && !hasReact
									&& (mine ? "rounded-bl-none" : "rounded-br-none"),
								last && (mine ? "rounded-br-sm" : "rounded-bl-sm"),
							)}
							style={{
								"--code-outset": isBubble ? `${CODE_OUTSET}px` : undefined,
								background: isBubble
									? target === uid && isUser
										? "color-mix(in oklch, var(--accent) 75%, transparent)"
										: mentioned?.has(uid)
										? "color-mix(in oklch, var(--accent) 25%, var(--muted))"
										: "var(--muted)"
									: "transparent",
								boxShadow: tone
									? `inset 3px 0 0 ${tone}`
									: mentioned?.has(uid)
									? "inset 3px 0 0 var(--accent)"
									: undefined,
								// Outlines never affect measured layout.
								outline: state === "failed" ? "1px solid var(--destructive)" : undefined,
								padding: isBubble ? `${BUBBLE_PAD_Y}px ${BUBBLE_PAD_X}px` : 0,
								inlineSize: isBubble ? wide : undefined,
								maxInlineSize: isBubble ? "100%" : undefined,
							} as Style}
						>
							{label && <span className="sr-only">Sent to {label}</span>}
							{state && (
								<span className="sr-only">{state === "failed" ? "Not sent" : "Sending"}</span>
							)}
							<div
								className={cn(
									"transition-opacity duration-150 ease-out motion-reduce:transition-none",
									edit ? "opacity-20" : state && "opacity-60",
								)}
							>
								<BlockList blocks={b} width={fit} />
							</div>
						</div>
						{reactions && reactions.length > 0 && (
							<Reactions
								reactions={reactions}
								align={mine ? "right" : "left"}
								currentUser={currentUser}
								onReact={onReact && ((emoji) => onReact(uid, emoji))}
								onOpenChange={onOpenChange}
							/>
						)}
					</div>
				);
			})}
		</div>
	);
}

// -- Component --

type TimelineProps =
	& Omit<ComponentPropsWithRef<"div">, "children" | "onCopy" | "onScrollEnd" | "ref">
	& {
		/** Chronological event stream to render. */
		events: Event[];
		/** Hide message actions when the caller only supports reading the timeline. */
		toolbar?: boolean;
		/** Available actions, optionally resolved for each message; omitted entries retain existing behavior. */
		actions?: MessageToolbarProps["actions"] | ((uid: string) => MessageToolbarProps["actions"]);
		/** Repository full name used to link git system events. */
		project?: REPO;
		/** Optional channel metadata shown on the first day divider. */
		intro?: TimelineIntro;
		/** Whether the agent is actively working — controls intent row visibility. */
		working?: TimelineWorking;
		/** Avatar URLs keyed by sender value (e.g. `"terkelg"`, `"ace:bot"`). */
		avatars?: Record<string, string>;
		/** Login-based mention profiles used when rendering message text. */
		mentions?: Mention[];
		/** Documents resolved from &name.md references, including historical aliases. */
		documents?: readonly DocumentCandidate[];
		/**
		 * The current user. `own` matches verified current/historical author IDs exclusively.
		 * Legacy callers can match `id` or `login`. Controls toolbar edit/delete visibility and the highlighted state on
		 * reaction chips. `id` is optional but recommended — without it, "is this my message"
		 * falls back to comparing against `login`.
		 */
		currentUser?: Event.Viewer;
		/** Where own user messages render in the timeline. Defaults to `"left"`. */
		alignment?: "left" | "right";
		/** Message UID currently loaded into the composer for editing. */
		editing?: string;
		/** Own messages that have not reached the server yet, or were rejected. */
		unsent?: ReadonlyMap<string, Unsent>;
		/** Message UIDs whose toolbar should expose Edit. */
		editable?: ReadonlySet<string>;
		/** Called when the user picks an emoji from the toolbar's emoji picker. */
		onReact?: (uid: string, emoji: string) => void;
		/** Message UID to scroll into view. */
		target?: string;
		/** The first message the viewer hasn't seen, which a New divider sits above. */
		unread?: string;
		/** Messages that mention the viewer, which are highlighted. */
		mentioned?: ReadonlySet<string>;
		/** Called when the user clicks a rendered message link. */
		onLink?: (href: string) => void;
		/** How to open a sender whose name links somewhere, such as the channel that sent it. */
		openSender?: (sender: string) => (() => void) | undefined;
		/** Called when the user clicks a resolved document reference. */
		onDocumentOpen?: (uid: DocumentCandidate["uid"]) => void;
		/** Called when the user clicks the reserved Plan reference. */
		onPlanOpen?: () => void;
		/** Called when the user clicks a generated artifact file. */
		onFileOpen?: (file: string) => void;
		/** Called when the user clicks an edited file in the turn summary. */
		onDiffFileOpen?: (file: string) => void;
		/** Called when the user clicks the edited-files review action. */
		onReviewChanges?: () => void;
		/** Called when the user clicks the toolbar's copy button. */
		onCopy?: (uid: string) => void;
		/** Called when the user clicks the toolbar's permalink button. */
		onPermalink?: (uid: string) => void;
		/** Called when the user clicks the toolbar's edit button (only fires for own messages). */
		onEdit?: (uid: string) => void;
		/** Called when the user clicks the toolbar's delete button (only fires for own messages). */
		onDelete?: (uid: string) => void;
		/** Called when the user uses terminal command row actions. */
		onExecAction?: (action: TimelineExecAction, exec: TimelineExec) => void;
		/** Called when the viewport-visible message IDs or bottom-pinned state changes. */
		onVisibilityChange?: (visibility: TimelineVisibility) => void;
		/** Imperative scroll handle (forwarded from the underlying ScrollView). */
		ref?: Ref<ScrollViewHandle>;
	};

/**
 * Virtualized chat timeline. Takes a stream of events, compiles them into
 * message groups and system rows, then renders each with pixel-precise heights
 * via the Block protocol so the scroll container never has to read the DOM.
 */
function useTimeline(
	{
		events,
		toolbar = true,
		actions,
		project,
		intro,
		working = false,
		avatars,
		mentions,
		documents,
		currentUser,
		alignment = "left",
		editing,
		unsent,
		mentioned,
		editable,
		onReact,
		target,
		unread,
		onLink,
		openSender,
		onDocumentOpen,
		onPlanOpen,
		onFileOpen,
		onDiffFileOpen,
		onReviewChanges,
		onCopy,
		onPermalink,
		onEdit,
		onDelete,
		onExecAction,
		onVisibilityChange,
		ref,
		onClickCapture,
		onPointerEnter,
		onPointerMove,
		className,
		style,
		...props
	}: TimelineProps,
) {
	let [expanded, setExpanded] = useState(() => new Set<string>());
	let [expandedResults, setExpandedResults] = useState(() => new Set<string>());
	let [openGroups, setOpenGroups] = useState(() => new Set<string>());
	let [openWorking, setOpenWorking] = useState(() => new Set<string>());
	let [settlingWorking, setSettlingWorking] = useState(() => new Set<string>());
	let [hover, setHover] = useState<string | null>(null);
	let held = useRef(false);
	let [range, setRange] = useState<ScrollViewRange | null>(null);
	let scroll = useRef<ScrollViewHandle | null>(null);
	let timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	let rollup = useRef(new Set<ReturnType<typeof setTimeout>>());
	let seenFinalWorking = useRef<Set<string> | null>(null);
	let point = useRef<{ x: number; y: number } | null>(null);
	let suppress = useRef(false);
	let timeline = useMemo(() => compile(events, working, project, unread), [
		events,
		working,
		project,
		unread,
	]);
	let finalWorkingKey = useMemo(() => finalWorkingIds(timeline).join("\0"), [timeline]);
	let visibleWorking = useMemo(() => {
		let next = new Set(openWorking);
		for (let id of settlingWorking) next.add(id);
		return next;
	}, [openWorking, settlingWorking]);
	let toggle = (id: string) => {
		let closing = expanded.has(id);

		if (closing) {
			setExpanded(prev => {
				let next = new Set(prev);
				next.delete(id);
				return next;
			});
			setExpandedResults(prev => {
				if (!prev.has(id)) return prev;
				let next = new Set(prev);
				next.delete(id);
				return next;
			});
			return;
		}

		setExpanded(prev => {
			let next = new Set(prev);
			next.add(id);
			return next;
		});
	};
	let toggleResult = (id: string) => {
		setExpandedResults(prev => {
			let next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	let toggleGroup = (id: string) => {
		setOpenGroups(prev => {
			let next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	let scheduleWorkingSettle = useCallback((ids: string[]) => {
		// Each rollup timer removes itself on completion; the unmount cleanup
		// below cancels every remaining handle in rollup.current.
		let timer = setTimeout(() => {
			rollup.current.delete(timer);
			setSettlingWorking(prev => {
				let next = new Set(prev);
				for (let id of ids) next.delete(id);
				return next;
			});
		}, WORKING_ROLLUP_MS);
		rollup.current.add(timer);
	}, []);
	let toggleWorking = (id: string) => {
		let closing = openWorking.has(id);

		if (closing) {
			setOpenWorking(prev => {
				let next = new Set(prev);
				next.delete(id);
				return next;
			});
			setSettlingWorking(prev => {
				let next = new Set(prev);
				next.add(id);
				return next;
			});
			scheduleWorkingSettle([id]);
			return;
		}

		setSettlingWorking(prev => {
			if (!prev.has(id)) return prev;
			let next = new Set(prev);
			next.delete(id);
			return next;
		});
		setOpenWorking(prev => {
			let next = new Set(prev);
			next.add(id);
			return next;
		});
	};

	let cancelHide = () => {
		if (timer.current) {
			clearTimeout(timer.current);
			timer.current = null;
		}
	};
	let scheduleHide = () => {
		cancelHide();
		timer.current = setTimeout(() => setHover(null), 150);
	};
	let onRowEnter = (uid: string) => {
		if (suppress.current) return;
		cancelHide();
		if (hover !== uid) setHover(uid);
	};
	let onRowLeave = () => {
		if (suppress.current) return;
		if (held.current) return;
		scheduleHide();
	};
	let restoreHover = () => {
		let pos = point.current;
		let vp = scroll.current?.viewport();
		if (!pos || !vp) return;

		let target = document.elementFromPoint(pos.x, pos.y);
		if (!(target instanceof Element) || !vp.contains(target)) return;

		let node = target.closest<HTMLElement>("[data-message-id], [data-hover-message-id]");
		let id = node?.dataset.messageId || node?.dataset.hoverMessageId;
		if (id) onRowEnter(id);
	};
	let onScrollStart = () => {
		if (suppress.current) return;
		suppress.current = true;
		cancelHide();
		setHover(null);
	};
	let onScrollEnd = () => {
		suppress.current = false;
		restoreHover();
	};
	let onEnter = (e: PointerEvent<HTMLDivElement>) => {
		point.current = { x: e.clientX, y: e.clientY };
		onPointerEnter?.(e);
	};
	let onMove = (e: PointerEvent<HTMLDivElement>) => {
		point.current = { x: e.clientX, y: e.clientY };
		onPointerMove?.(e);
	};
	let onOpenChange = (o: boolean) => {
		held.current = o;
		if (o) cancelHide();
		else scheduleHide();
	};
	let onClick = (e: MouseEvent<HTMLDivElement>) => {
		onClickCapture?.(e);
		if (e.defaultPrevented) return;
		if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

		let target = e.target;
		if (!(target instanceof Element)) return;
		let plan = target.closest<HTMLElement>("[data-plan-reference]");
		if (plan && e.currentTarget.contains(plan) && onPlanOpen) {
			e.preventDefault();
			onPlanOpen();
			return;
		}
		let document = target.closest<HTMLElement>("[data-document-uid]");
		if (document && e.currentTarget.contains(document) && onDocumentOpen) {
			let uid = document.dataset.documentUid;
			if (uid) {
				e.preventDefault();
				onDocumentOpen(uid);
				return;
			}
		}
		if (!onLink) return;
		let link = target.closest<HTMLAnchorElement>("a[href]");
		if (!link || !e.currentTarget.contains(link)) return;

		e.preventDefault();
		onLink(link.href);
	};
	let onToolbarAction = (uid: string, action: MessageToolbarAction) => {
		switch (action.type) {
			case "react":
				onReact?.(uid, action.emoji);
				break;
			case "copy":
				onCopy?.(uid);
				break;
			case "permalink":
				onPermalink?.(uid);
				break;
			case "edit":
				onEdit?.(uid);
				break;
			case "delete":
				onDelete?.(uid);
				break;
		}
	};

	let setScroll = (handle: ScrollViewHandle | null) => {
		scroll.current = handle;
		if (typeof ref === "function") ref(handle);
		else if (ref) (ref as { current: ScrollViewHandle | null }).current = handle;
	};

	let labels: Mention[] | undefined = mentions ?? (avatars
		? Object.entries(avatars).map(([name, avatar]) => ({ name, avatar }))
		: undefined);
	if (documents?.length) {
		let signature = documents.map(document =>
			[document.uid, document.name, ...(document.aliases || [])].join("\u0001")
		).join("\u0002");
		let carrier = { name: `\uE100${signature}`, documents } as Mention & {
			documents: readonly DocumentCandidate[];
		};
		labels = [...(labels || []), carrier];
	}
	let blocks = useBlockMap(timeline, labels, expanded, expandedResults, undefined, !!onPlanOpen);
	let requested = useRef<string | null>(null);
	let resolved = useRef<string | null>(null);

	// Timers live outside React; clear any delayed hover or rollup work on unmount.
	useEffect(() => {
		return () => {
			if (timer.current) {
				clearTimeout(timer.current);
				timer.current = null;
			}
			for (let id of rollup.current) clearTimeout(id);
			rollup.current.clear();
		};
	}, []);

	// When a final answer arrives, keep the working context mounted long enough to roll it up before the browser paints the settled frame.
	useLayoutEffect(() => {
		let ids = finalWorkingKey ? new Set(finalWorkingKey.split("\0")) : new Set<string>();
		let prev = seenFinalWorking.current;
		if (!prev) {
			seenFinalWorking.current = ids;
			return;
		}

		seenFinalWorking.current = ids;
		let fresh = [...ids].filter(id => !prev.has(id));
		if (!fresh.length) return;

		setSettlingWorking(prev => {
			let next = new Set(prev);
			for (let id of fresh) next.add(id);
			return next;
		});

		scheduleWorkingSettle(fresh);
	}, [finalWorkingKey, scheduleWorkingSettle]);

	// Resolve permalink targets against the latest virtual-scroll frame, then center the row.
	useEffect(() => {
		if (requested.current !== target) {
			requested.current = target || null;
			resolved.current = null;
		}
		if (!target) {
			resolved.current = null;
			return;
		}
		if (resolved.current === target) return;
		let index = find(timeline, target);
		if (index < 0) return;

		resolved.current = target;
		scroll.current?.scrollTo(index);
		let frame = requestAnimationFrame(() => {
			let row = scroll.current?.viewport()?.querySelector<HTMLElement>(
				`[data-message-id="${CSS.escape(target)}"]`,
			);
			row?.scrollIntoView({ block: "center" });
		});
		return () => cancelAnimationFrame(frame);
	}, [target, timeline]);

	let notify = useEffectEvent((value: TimelineVisibility) => onVisibilityChange?.(value));
	useLayoutEffect(() => {
		if (!onVisibilityChange || !range) return;
		let vp = scroll.current?.viewport();
		if (!vp) return;

		let rect = vp.getBoundingClientRect();
		let messages = new Set<string>();
		for (let node of vp.querySelectorAll<HTMLElement>("[data-message-id]")) {
			let id = node.dataset.messageId;
			if (!id) continue;

			let box = node.getBoundingClientRect();
			if (box.bottom > rect.top && box.top < rect.bottom) messages.add(id);
		}

		notify({ pinned: range.pinned, messages: [...messages] });
	}, [range, onVisibilityChange, timeline]);

	return {
		onExecAction,
		expandedResults,
		toggle,
		toggleResult,
		setScroll,
		timeline,
		blocks,
		openGroups,
		visibleWorking,
		setRange,
		onScrollStart,
		onScrollEnd,
		onClick,
		onEnter,
		onMove,
		className,
		style,
		props,
		intro,
		working,
		avatars,
		currentUser,
		alignment,
		target,
		editing,
		unsent,
		mentioned,
		editable,
		openWorking,
		settlingWorking,
		toggleWorking,
		toggleGroup,
		onRowEnter,
		onRowLeave,
		onReact,
		onLink,
		openSender,
		onFileOpen,
		onDiffFileOpen,
		onReviewChanges,
		actions,
		hover: toolbar ? hover : null,
		onToolbarAction,
		onOpenChange,
	};
}

function Timeline(input: TimelineProps) {
	let {
		actions,
		onExecAction,
		expandedResults,
		toggle,
		toggleResult,
		setScroll,
		timeline,
		blocks,
		openGroups,
		visibleWorking,
		setRange,
		onScrollStart,
		onScrollEnd,
		onClick,
		onEnter,
		onMove,
		className,
		style,
		props,
		intro,
		working,
		avatars,
		currentUser,
		alignment,
		target,
		editing,
		unsent,
		mentioned,
		editable,
		openWorking,
		settlingWorking,
		toggleWorking,
		toggleGroup,
		onRowEnter,
		onRowLeave,
		onReact,
		onLink,
		openSender,
		onFileOpen,
		onDiffFileOpen,
		onReviewChanges,
		hover,
		onToolbarAction,
		onOpenChange,
	} = useTimeline(input);
	return (
		<ExecActionProvider value={onExecAction ?? null}>
			<ToolProvider value={{ expandedResults, toggle, toggleResult }}>
				<ScrollView
					ref={setScroll}
					count={timeline.length}
					height={(i, w) =>
						itemHeight(timeline[i]!, blocks, Math.min(w, LANE), openGroups, visibleWorking)}
					gap={GAP}
					end={TAIL}
					onRangeChange={setRange}
					onScrollStart={onScrollStart}
					onScrollEnd={onScrollEnd}
					onClickCapture={onClick}
					onPointerEnter={onEnter}
					onPointerMove={onMove}
					className={cn(className, "scrollbar-muted")}
					style={style}
					{...props}
				>
					{(index, width) => {
						let item = timeline[index]!;
						let lane = Math.min(width, LANE);
						if (item.kind === "day") {
							let start = index === 0 ? intro : undefined;
							let first = !!start;
							let label = start ? introLabel(start) : dayLabel(item.ts);
							return (
								<div
									className={cn(
										"utils:max-width flex min-w-0 items-center overflow-hidden text-[0.6875rem] leading-4 text-muted-foreground",
										first ? "justify-center" : "gap-2",
									)}
									style={{
										paddingInline: PAD,
										blockSize: DAY_HEIGHT,
									}}
								>
									{!first && <div className="h-px min-w-2 flex-1 bg-border" />}
									<span className="block min-w-0 max-w-[76%] truncate text-center" title={label}>
										{label}
									</span>
									{!first && <div className="h-px min-w-2 flex-1 bg-border" />}
								</div>
							);
						}
						if (item.kind === "new") {
							return (
								<div
									role="separator"
									aria-label="New messages"
									className="utils:max-width flex items-center gap-2 text-[0.6875rem] leading-4 font-medium"
									style={{ paddingInline: PAD, blockSize: DAY_HEIGHT }}
								>
									<div className="h-px min-w-2 flex-1 bg-accent" />
									<span className="rounded-full bg-accent px-1.5 text-accent-foreground">New</span>
								</div>
							);
						}
						if (item.kind === "event") {
							let content = lane - PAD * 2 - AVATAR - AVATAR_GAP;
							return (
								<div
									className="utils:max-width flex items-start"
									style={{
										paddingInline: PAD,
										blockSize: "100%",
										gap: AVATAR_GAP,
									}}
								>
									<EventGlyph row={item.row} />
									<div className="min-w-0 flex-1">
										<EventBlockList
											blocks={blocks.get(item.row.uid) || []}
											row={item.row}
											width={content}
										/>
									</div>
								</div>
							);
						}
						return (
							<div className="utils:max-width" style={{ blockSize: "100%" }}>
								<GroupView
									group={item.group}
									actions={actions}
									turn={item.turn}
									blocks={blocks}
									width={lane}
									loading={!!working && index === timeline.length - 1
										&& item.group.role === "assistant"}
									avatars={avatars}
									currentUser={currentUser}
									alignment={alignment}
									target={target}
									editing={editing}
									unsent={unsent}
									editable={editable}
									mentioned={mentioned}
									openGroups={openGroups}
									openWorking={openWorking}
									settlingWorking={settlingWorking}
									onToggleWorking={toggleWorking}
									onToggleGroup={toggleGroup}
									onRowEnter={onRowEnter}
									onRowLeave={onRowLeave}
									onReact={onReact}
									onLink={onLink}
									openSender={openSender}
									onFileOpen={onFileOpen}
									onDiffFileOpen={onDiffFileOpen}
									onReviewChanges={onReviewChanges}
									hover={hover}
									onToolbarAction={onToolbarAction}
									onOpenChange={onOpenChange}
								/>
							</div>
						);
					}}
				</ScrollView>
			</ToolProvider>
		</ExecActionProvider>
	);
}

export {
	Timeline,
	type TimelineExec,
	type TimelineExecAction,
	type TimelineIntro,
	type TimelineProps,
	type TimelineVisibility,
};
