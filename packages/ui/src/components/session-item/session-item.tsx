import type { ComponentPropsWithRef, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { Facepile } from "../facepile/facepile";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";

import { RowMenu } from "./session-item-actions";
import { RowGlyph } from "./session-item-glyph";
import type { MoveTarget, SidebarRow } from "./session-item.types";
import {
	IconArrowUpRight as ArrowUpRight,
	IconCircleCheck as CircleCheck,
	IconCircleDashed as CircleDotted,
	IconCircleX as CircleXmark,
} from "../../icons";

const PRESENCE_CAP = 3;
const PRESENCE_SIZE = 20;
const HOVER_EXPAND_DELAY = 1_200;
const EXPANDED_CONTENT_PADDING_BOTTOM =
	"data-[open=true]:pb-(--session-item-expanded-padding-bottom)";
const TITLE_TO_EXPANDED_CONTENT_GAP = "data-[open=true]:mt-(--session-item-title-to-content-gap)";
const EXPANDED_CONTENT_ROW_GAP = "gap-y-1";

export type SessionItemProps = ComponentPropsWithRef<"button"> & {
	data: SidebarRow;
	selected?: boolean;
	pinned?: boolean;
	hoverExpand?: boolean;
	hoverExpandDelay?: number;
	expanded?: boolean;
	expandedContent?: ReactNode | ((data: SidebarRow) => ReactNode);
	onPin?: (data: SidebarRow) => void;
	onUnpin?: (data: SidebarRow) => void;
	onArchive?: (data: SidebarRow) => void;
	onFork?: (data: SidebarRow) => void;
	onInfo?: (data: SidebarRow) => void;
	onLeave?: (data: SidebarRow) => void;
	onDelete?: (data: SidebarRow) => void;
	onRebuild?: (data: SidebarRow) => void;
	onRename?: (data: SidebarRow) => void;
	onMoveTargets?: (data: SidebarRow) => Promise<MoveTarget[]>;
	onMove?: (data: SidebarRow, target: MoveTarget) => Promise<void>;
	/** Offered on rows whose capabilities include `compute`. */
	onCompute?: (data: SidebarRow, action: "start" | "stop") => void;
};

function avatar(member: SidebarRow["online"][number]) {
	return {
		src: member.avatar || `https://github.com/${member.id}.png?size=40`,
		alt: member.away ? `${member.name} (away)` : member.name,
		dimmed: member.away,
	};
}

/** People here in a channel or project; away people are dimmed, and the tooltip names everyone. */
export function Presence({ members }: { members: SidebarRow["online"] }) {
	if (members.length === 0) return null;

	let visible = members.map(avatar);

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={`Here: ${visible.map((member) => member.alt).join(", ")}`}
						// The facepile sits inside the row's button; an empty title keeps the row's summary
						// tooltip from covering this one.
						title=""
						className="shrink-0 rounded-full"
					/>
				}
			>
				<Facepile avatars={visible} max={PRESENCE_CAP} size={PRESENCE_SIZE} />
			</TooltipTrigger>
			<TooltipContent side="right" sideOffset={8}>
				<span className="flex flex-col">
					{members.map((member) => (
						<span key={member.id}>
							{member.name}
							{member.away && <span className="text-background/60">{" "}away</span>}
						</span>
					))}
				</span>
			</TooltipContent>
		</Tooltip>
	);
}

function messageText(count: number) {
	if (count <= 0) return undefined;
	return `${count} new ${count === 1 ? "message" : "messages"}`;
}

function ciText(pr: NonNullable<SidebarRow["pr"]>) {
	if (pr.ci === "none") return undefined;
	if (pr.ci === "failed") {
		let count = pr.checks?.failed ?? 1;
		return `${count} ${count === 1 ? "test" : "tests"} failed`;
	}
	if (pr.ci === "passed") return "Tests passed";
	if (pr.ci === "pending") {
		if (pr.checks) {
			let left = Math.max(pr.checks.total - pr.checks.completed, 0);
			return `${left}/${pr.checks.total} tests left`;
		}
		return "tests running";
	}
	return undefined;
}

function CiIcon({ ci }: { ci: NonNullable<SidebarRow["pr"]>["ci"] }) {
	if (ci === "failed") return <CircleXmark className="size-3.5 shrink-0" />;
	if (ci === "passed") return <CircleCheck className="size-3.5 shrink-0" />;
	return <CircleDotted className="size-3.5 shrink-0" />;
}

function openPr(event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>, url?: string) {
	if (!url) return;
	event.preventDefault();
	event.stopPropagation();
	window.open(url, "_blank", "noopener,noreferrer");
}

function keyPr(event: KeyboardEvent<HTMLSpanElement>, url?: string) {
	if (event.key === "Enter") openPr(event, url);
}

function PrLink({ pr }: { pr: NonNullable<SidebarRow["pr"]> }) {
	let interactive = Boolean(pr.url);
	return (
		<span
			role={interactive ? "link" : undefined}
			tabIndex={interactive ? 0 : undefined}
			className={cn(
				"-mx-1 inline-flex min-w-0 items-center gap-0.5 rounded-full px-1 py-0.5 font-medium text-accent transition-colors",
				interactive
					&& "cursor-pointer hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-ring/50",
			)}
			onClick={(event) => openPr(event, pr.url)}
			onKeyDown={(event) => keyPr(event, pr.url)}
		>
			<span>{pr.number}</span>
			<ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
		</span>
	);
}

function defaultExpandedContent(data: SidebarRow) {
	let pr = data.pr;
	let ci = pr ? ciText(pr) : undefined;
	if (pr && ci) {
		return (
			<span className="flex min-w-0 items-center gap-x-3">
				<PrLink pr={pr} />
				<span
					className={cn(
						"inline-flex min-w-0 items-center gap-1",
						pr.ci === "passed" && "text-accent",
						pr.ci === "failed" && "text-destructive",
					)}
				>
					<CiIcon ci={pr.ci} />
					<span className="tabular-nums">{ci}</span>
				</span>
			</span>
		);
	}

	let messages = messageText(data.unreadCount);
	if (!messages) return null;
	return (
		<span className={cn("flex min-w-0 flex-wrap items-center gap-x-3", EXPANDED_CONTENT_ROW_GAP)}>
			<span className="shrink-0">{messages}</span>
		</span>
	);
}

function hasContent(content: ReactNode): boolean {
	if (Array.isArray(content)) return content.some(hasContent);
	if (content === null || content === undefined || content === false) return false;
	if (typeof content === "string") return content.trim().length > 0;
	return true;
}

type RowActions = Pick<
	SessionItemProps,
	| "onPin"
	| "onUnpin"
	| "onFork"
	| "onInfo"
	| "onLeave"
	| "onDelete"
	| "onArchive"
	| "onRename"
	| "onRebuild"
	| "onMoveTargets"
	| "onMove"
	| "onCompute"
>;

function actions(data: SidebarRow, props: RowActions): RowActions {
	if (data.kind === "lobby") return { onRebuild: props.onRebuild };
	let pins = { onPin: props.onPin, onUnpin: props.onUnpin };
	// Archived channels leave every group but Archived, so a pin would never show.
	if (data.lifecycle === "archived") {
		return {
			onArchive: data.capabilities?.archive === false ? undefined : props.onArchive,
			onDelete: data.capabilities?.delete === false ? undefined : props.onDelete,
		};
	}
	return {
		...pins,
		onFork: data.capabilities?.fork === false ? undefined : props.onFork,
		onInfo: props.onInfo,
		onLeave: props.onLeave,
		onArchive: data.capabilities?.archive === false ? undefined : props.onArchive,
		onRename: data.capabilities?.rename === false ? undefined : props.onRename,
		...(data.capabilities?.move
			? { onMoveTargets: props.onMoveTargets, onMove: props.onMove }
			: {}),
		...(data.capabilities?.compute ? { onCompute: props.onCompute } : {}),
	};
}

function expandedBody(data: SidebarRow, content: SessionItemProps["expandedContent"]) {
	return typeof content === "function" ? content(data) : content ?? defaultExpandedContent(data);
}

function buttonClass(hoverExpand: boolean | undefined, className?: string) {
	return cn(
		"relative flex h-[calc(var(--spacing)*8-2px)] w-full px-1 text-left",
		hoverExpand ? "flex-col items-stretch justify-center gap-0" : "items-center gap-1.5",
		"rounded-lg squircle border border-transparent bg-clip-padding",
		"data-[status=active]:z-1 data-[status=active]:bg-popover/35 dark:data-[status=active]:bg-black/32",
		"data-[status=active]:backdrop-blur-[1px]",
		"data-[status=active]:selected-surface",
		"data-[status=active]:text-accent-text data-[status=active]:font-medium",
		hoverExpand
			&& "transition-[background-color,filter] duration-150 ease-out motion-reduce:transition-none data-[expanded=true]:rounded-b-none data-[expanded=true]:bg-popover data-[expanded=true]:hover:bg-popover",
		"group-data-[primary=true]/menu:active:translate-y-px group-data-[primary=true]/menu:active:brightness-95",
		"outline-2 outline-offset-0 outline-transparent focus-visible:outline-ring/50",
		className,
	);
}

/**
 * A single session row in the sidebar.
 */
export function SessionItem(
	{
		data,
		selected,
		pinned,
		hoverExpand,
		hoverExpandDelay = HOVER_EXPAND_DELAY,
		expanded,
		expandedContent,
		onPin,
		onUnpin,
		onArchive,
		onFork,
		onInfo,
		onLeave,
		onDelete,
		onRebuild,
		onRename,
		onMoveTargets,
		onMove,
		onCompute,
		className,
		ref,
		onMouseEnter,
		onMouseLeave,
		...props
	}: SessionItemProps,
) {
	let menu = actions(data, {
		onPin,
		onUnpin,
		onFork,
		onInfo,
		onLeave,
		onDelete,
		onArchive,
		onRename,
		onRebuild,
		onMoveTargets,
		onMove,
		onCompute,
	});
	let [hovered, setHovered] = useState(false);
	let timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	let content = hoverExpand ? expandedBody(data, expandedContent) : null;
	let canExpand = hoverExpand && !selected && hasContent(content);
	let open = canExpand && (expanded || hovered);
	let status = selected ? "active" : undefined;
	let expansion = open ? "true" : undefined;
	let preview = data.summary && data.summary.length > 180
		? `${data.summary.slice(0, 177).trimEnd()}…`
		: data.summary;
	let line = (
		<>
			<span className="@container grid size-6 place-items-center shrink-0 text-muted-foreground group-data-[status=active]/row:text-current/80 [&_svg]:size-4.5 [&_svg]:shrink-0">
				<RowGlyph data={data} selected={selected} />
			</span>
			<span className="min-w-0 truncate">{data.name}</span>
			<Presence members={data.online} />
		</>
	);

	function enter(event: MouseEvent<HTMLButtonElement>) {
		onMouseEnter?.(event);
		if (!canExpand || expanded) return;
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setHovered(true), hoverExpandDelay);
	}

	function leave(event: MouseEvent<HTMLButtonElement>) {
		onMouseLeave?.(event);
		clearTimeout(timer.current);
		setHovered(false);
	}

	useEffect(() => {
		return () => clearTimeout(timer.current);
	}, []);

	return (
		<RowMenu data={data} pinned={pinned} {...menu}>
			<div
				data-status={status}
				data-lifecycle={data.lifecycle}
				data-expanded={expansion}
				className={cn(
					"group/row relative z-0 w-full text-sm data-[status=active]:z-1",
					hoverExpand
						? cn(
							"-my-0.5 overflow-visible",
							"[--session-item-expanded-padding-top:calc(var(--spacing)*1.5)]",
							"[--session-item-expanded-padding-bottom:calc(var(--spacing)*2)]",
							"[--session-item-title-to-content-gap:-2px]",
							"[--session-item-expanded-content-indent:calc(var(--spacing)*8)]",
						)
						: "-my-0.5",
					"rounded-lg squircle",
					"not-data-[status=active]:hover:bg-background/50",
					"not-data-[status=active]:hover:backdrop-blur-[1px]",
					"group-data-[menu-open=true]/menu:not-data-[status=active]:bg-background/50",
					"group-data-[menu-open=true]/menu:not-data-[status=active]:backdrop-blur-[1px]",
					hoverExpand && "isolate data-[expanded=true]:z-50 data-[expanded=true]:drop-shadow-lg",
				)}
			>
				<button
					ref={ref}
					type="button"
					data-status={status}
					data-lifecycle={data.lifecycle}
					data-expanded={expansion}
					aria-current={selected ? "page" : undefined}
					aria-description={preview}
					title={preview}
					onMouseEnter={enter}
					onMouseLeave={leave}
					className={buttonClass(hoverExpand, className)}
					{...props}
				>
					{hoverExpand
						? (
							<>
								<span className="flex h-full min-w-0 items-center gap-1.5">
									{line}
								</span>
								<span
									aria-hidden={!open}
									inert={open ? undefined : true}
									className={cn(
										"absolute inset-x-0 top-full z-10 grid grid-rows-[0fr] rounded-t-none rounded-b-lg squircle bg-popover opacity-0 transition-[opacity,transform,grid-template-rows] duration-150 ease-out motion-reduce:transition-none",
										"data-[open=true]:translate-y-0 data-[open=true]:grid-rows-[1fr] data-[open=true]:opacity-100",
										TITLE_TO_EXPANDED_CONTENT_GAP,
										EXPANDED_CONTENT_PADDING_BOTTOM,
									)}
									data-open={expansion}
								>
									<span className="min-h-0 overflow-hidden pr-1 pl-(--session-item-expanded-content-indent) text-xs font-medium text-muted-foreground">
										<span className="block min-w-0">{content}</span>
									</span>
								</span>
							</>
						)
						: line}
				</button>
			</div>
		</RowMenu>
	);
}
