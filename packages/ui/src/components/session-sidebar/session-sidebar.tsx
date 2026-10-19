import { SessionOptions } from "./session-options";
const EMPTY_REPOS: SessionSidebarRepo[] = [];

import type { ComponentPropsWithRef, MouseEvent, ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as format from "../../lib/format";
import { AnimatePresence, m as motion, useReducedMotion } from "motion/react";

import { Presence, SessionItem } from "../session-item/session-item";
import { SessionItemLoading } from "../session-item/session-item-loading";
import type { MoveTarget, SidebarRow } from "../session-item/session-item.types";
import { middle } from "../../lib/truncate";
import { cn } from "../../lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "../../ui/avatar";
import { Button } from "../../ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "../../ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Skeleton } from "../../ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../ui/tooltip";
import { isSidebarRowSelected } from "./selection";
import {
	IconArchive,
	IconArrowDownToLine,
	IconCheck,
	IconChevronDown,
	IconPlus,
	IconRows,
	IconTrash,
	IconX,
} from "../../icons";

export type SessionSidebarGroupId =
	| "pinned"
	| "mine"
	| "team"
	| "inactive"
	| "archived"
	| `project:${string}`
	/** A teammate's channels by owner, with `:archived` for their archived ones. */
	| `team:${string}`;

export type SessionSidebarGroup = {
	id: SessionSidebarGroupId;
	label: string;
	rows: SidebarRow[];
	/** Preserve caller ordering for ranked or hierarchical groups. */
	sort?: "creation" | "none";
	collapsed?: boolean;
	onNewSession?: () => void;
	/** Forget the project's folder on this host; its files stay. */
	onRemove?: () => void;
};

export type SessionSidebarRepo = {
	id: string;
	kind?: "project" | "all";
	name: string;
	org: string;
	avatar?: string;
	/** Shown on hover, such as the project's full path. */
	title?: string;
};

export type SessionSidebarProps = Omit<ComponentPropsWithRef<"aside">, "children" | "onSelect"> & {
	projectName?: string;
	/** People here in the selected project, shown beside the project picker. */
	here?: SidebarRow["online"];
	repos?: SessionSidebarRepo[];
	selectedRepoId?: SessionSidebarRepo["id"];
	groups: SessionSidebarGroup[];
	lobby?: SidebarRow;
	loading?: boolean;
	selectedUid?: SidebarRow["uid"];
	onRepoChange?: (repo: SessionSidebarRepo) => void;
	onRepoRemove?: (repo: SessionSidebarRepo) => void;
	onSelect?: (row: SidebarRow) => void;
	onPin?: (row: SidebarRow) => void;
	onUnpin?: (row: SidebarRow) => void;
	onArchive?: (row: SidebarRow) => void;
	/** When provided, the channels header's context menu offers "Archive inactive". */
	onArchiveInactive?: () => void;
	onFork?: (row: SidebarRow) => void;
	onInfo?: (row: SidebarRow) => void;
	onLeave?: (row: SidebarRow) => void;
	onDelete?: (row: SidebarRow) => void;
	onRebuildLobby?: (row: SidebarRow) => void;
	onRename?: (row: SidebarRow) => void;
	/** Rows whose capabilities allow moving list these destinations as "Move to …" items. */
	onMoveTargets?: (row: SidebarRow) => Promise<MoveTarget[]>;
	onMove?: (row: SidebarRow, target: MoveTarget) => Promise<void>;
	onCompute?: (row: SidebarRow, action: "start" | "stop") => void;
	onToggleGroup?: (id: SessionSidebarGroupId) => void;
	onNewSession?: () => void;
	/** When provided, a "…" menu button appears offering "Continue a pull request…". */
	onContinuePr?: () => void;
	/** When provided, the "…" menu offers "Start from an issue…". */
	onStartIssue?: () => void;
	onAddRepo?: () => void;
	/** When provided, the project menu offers "Clone from URL…" beside "Open folder…". */
	onCloneRepo?: () => void;
	groupHeaderClassName?: string;
	empty?: ReactNode;
};

const CHEVRON_TRANSITION = { duration: 0.15, ease: "easeOut" as const };
const CHEVRON_TRANSITION_REDUCED = { duration: 0, ease: "easeOut" as const };
const GROUP_TRANSITION = { duration: 0.18, ease: "easeOut" as const };
const GROUP_TRANSITION_REDUCED = { duration: 0, ease: "easeOut" as const };
const PANE_TRANSITION = { type: "spring" as const, duration: 0.28, bounce: 0 };
const PANE_TRANSITION_REDUCED = { duration: 0 };
const REPO_NAME_FONT = "12px Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

function count(groups: SessionSidebarGroup[]) {
	return groups.reduce((total, group) => total + group.rows.length, 0);
}

function byCreation(a: SidebarRow, b: SidebarRow) {
	return b.createdAt - a.createdAt || b.uid.localeCompare(a.uid);
}

function rowKey(row: SidebarRow) {
	return row.renderKey ?? row.uid;
}

function fallback(name: string) {
	return name.slice(0, 2).toUpperCase();
}

function byOrg(repos: SessionSidebarRepo[]) {
	let groups = new Map<string, SessionSidebarRepo[]>();
	for (let repo of repos) {
		if (repo.kind === "all") continue;
		let list = groups.get(repo.org);
		if (list) list.push(repo);
		else groups.set(repo.org, [repo]);
	}
	return [...groups];
}

function RepoAvatar({ repo, className }: { repo: SessionSidebarRepo; className?: string }) {
	if (repo.kind === "all") return <IconRows className={cn("size-4", className)} aria-hidden />;
	let name = repo.org || repo.name;
	let source = repo.avatar || (repo.org ? format.avatar(repo.org) : undefined);
	return (
		<Avatar className={cn("size-4 bg-transparent ring-0", className)}>
			{source && <AvatarImage src={source} alt={name} />}
			<AvatarFallback>{fallback(name)}</AvatarFallback>
		</Avatar>
	);
}

function RepoName({ name, title }: { name: string; title?: string }) {
	let root = useRef<HTMLSpanElement>(null);
	let [label, setLabel] = useState(name);

	useLayoutEffect(() => {
		function update() {
			let outer = root.current;
			if (!outer) return;
			let font = typeof getComputedStyle === "undefined"
				? REPO_NAME_FONT
				: getComputedStyle(outer).font || REPO_NAME_FONT;
			setLabel(middle(name, outer.clientWidth, font));
		}

		update();
		let observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
		if (root.current) observer?.observe(root.current);
		return () => {
			observer?.disconnect();
		};
	}, [name]);

	return (
		<span ref={root} className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-medium">
			<span
				title={title || (label === name ? undefined : name)}
				className="inline-block max-w-full align-bottom"
			>
				{label}
			</span>
		</span>
	);
}

function RepoRow({ repo, selected, onRepoChange, onRepoRemove }: {
	repo: SessionSidebarRepo;
	selected: boolean;
	onRepoChange?: (repo: SessionSidebarRepo) => void;
	onRepoRemove?: (repo: SessionSidebarRepo) => void;
}) {
	function remove(event: MouseEvent<HTMLButtonElement>) {
		event.preventDefault();
		event.stopPropagation();
		onRepoRemove?.(repo);
	}

	return (
		<DropdownMenuItem
			className={cn(
				"group/repo pr-1.5 hover:bg-muted/50 focus:bg-muted/50 data-highlighted:bg-muted/50",
				selected && "bg-muted hover:bg-muted focus:bg-muted data-highlighted:bg-muted",
			)}
			onClick={() => onRepoChange?.(repo)}
			onKeyDown={event => {
				if (event.target !== event.currentTarget || !onRepoRemove) return;
				if (event.key !== "Delete" && event.key !== "Backspace") return;
				event.preventDefault();
				event.stopPropagation();
				onRepoRemove(repo);
			}}
		>
			<RepoName name={repo.name} title={repo.title} />
			<span className="relative grid size-5 shrink-0 place-items-center">
				{selected && (
					<IconCheck className="size-3.5 transition-opacity duration-150 ease-out group-hover/repo:opacity-0 group-focus/repo:opacity-0 group-focus-within/repo:opacity-0" />
				)}
				{onRepoRemove && (
					<Tooltip>
						<TooltipTrigger
							render={
								<button
									type="button"
									aria-label={`Remove ${repo.name}`}
									className="absolute grid size-5 place-items-center rounded-md squircle text-muted-foreground opacity-0 outline-2 outline-offset-[-1px] outline-transparent transition-[background-color,color,opacity,transform] duration-150 ease-out hover:bg-foreground/10 hover:text-foreground focus-visible:bg-foreground/10 focus-visible:text-foreground focus-visible:outline-ring/50 active:translate-y-px group-hover/repo:text-foreground/80 group-hover/repo:opacity-100 group-focus/repo:text-foreground/80 group-focus/repo:opacity-100 group-focus-within/repo:text-foreground/80 group-focus-within/repo:opacity-100"
									onPointerDown={(event) => event.stopPropagation()}
									onMouseUp={(event) => event.stopPropagation()}
									onKeyDown={event => {
										if (event.key === "Enter" || event.key === " ") event.stopPropagation();
									}}
									onKeyUp={event => {
										if (event.key === "Enter" || event.key === " ") event.stopPropagation();
									}}
									onClick={remove}
								/>
							}
						>
							<IconX className="size-3" />
						</TooltipTrigger>
						<TooltipContent side="right" sideOffset={8}>
							Remove project
						</TooltipContent>
					</Tooltip>
				)}
			</span>
		</DropdownMenuItem>
	);
}

/** The shared project menu used by the session sidebar and project dashboard. */
export function ProjectPicker(
	{
		projectName,
		repos = EMPTY_REPOS,
		selectedRepoId,
		onRepoChange,
		onRepoRemove,
		onAddRepo,
		onCloneRepo,
		trigger,
		children,
	}: {
		projectName?: string;
		repos?: SessionSidebarRepo[];
		selectedRepoId?: SessionSidebarRepo["id"];
		onRepoChange?: (repo: SessionSidebarRepo) => void;
		onRepoRemove?: (repo: SessionSidebarRepo) => void;
		onAddRepo?: () => void;
		onCloneRepo?: () => void;
		trigger?: ReactElement;
		children?: ReactNode;
	},
) {
	let selected = repos.find((repo) => repo.id === selectedRepoId) ?? repos[0];
	let orgGroups = useMemo(() => byOrg(repos), [repos]);
	let all = repos.find((repo) => repo.kind === "all");

	if (!selected) {
		return <div className="truncate text-sm font-medium">{projectName ?? "Projects"}</div>;
	}
	let name = selected.org ? `${selected.org}/${selected.name}` : selected.name;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				title={selected.title}
				render={trigger || (
					<Button
						variant="ghost"
						className="-ml-1 h-7 w-[calc(100%+6px)] min-w-0 max-w-none justify-start gap-1.5 py-0 pr-2 pl-1.5 text-sidebar-foreground hover:bg-background/50 aria-expanded:bg-background/50"
						aria-label={`Select project, currently ${name}`}
					/>
				)}
			>
				{children || (
					<>
						<RepoAvatar repo={selected} />
						<span className="min-w-0 truncate text-xs/relaxed font-medium">{selected.name}</span>
						<IconChevronDown
							strokeWidth={3.3}
							className="ml-auto size-2.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-in-out motion-reduce:transition-none group-data-[popup-open]/button:rotate-180"
						/>
					</>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				sideOffset={6}
				className="max-h-[400px] inline-[186px] select-none"
			>
				{all && (
					<>
						<RepoRow repo={all} selected={all.id === selected.id} onRepoChange={onRepoChange} />
						<DropdownMenuSeparator className="my-0.5" />
					</>
				)}
				{(onAddRepo || onCloneRepo) && (
					<>
						{onAddRepo && (
							<DropdownMenuItem className={cn("mt-0", !onCloneRepo && "mb-1")} onClick={onAddRepo}>
								<IconPlus className="size-3.5 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate">Open folder…</span>
							</DropdownMenuItem>
						)}
						{onCloneRepo && (
							<DropdownMenuItem className="mt-0 mb-1" onClick={onCloneRepo}>
								<IconArrowDownToLine className="size-3.5 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate">Clone from URL…</span>
							</DropdownMenuItem>
						)}
						{orgGroups.length > 0 && <DropdownMenuSeparator className="my-0.5" />}
					</>
				)}
				{orgGroups.map(([org, list], index) => (
					<DropdownMenuGroup
						key={org}
						className={index === orgGroups.length - 1 ? "mb-0.5" : undefined}
					>
						{index > 0 && <DropdownMenuSeparator className="my-1.5" />}
						<DropdownMenuLabel className="py-1 pr-2 pl-2">
							<span className="truncate">{org || "Projects"}</span>
						</DropdownMenuLabel>
						{list.map((repo) => (
							<RepoRow
								key={repo.id}
								repo={repo}
								selected={repo.id === selected.id}
								onRepoChange={onRepoChange}
								onRepoRemove={onRepoRemove}
							/>
						))}
					</DropdownMenuGroup>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function GroupHeaderContent({ group, collapsed }: {
	group: SessionSidebarGroup;
	collapsed: boolean;
}) {
	let reduced = useReducedMotion();

	return (
		<>
			{group.id === "archived" && (
				<IconArchive
					aria-hidden
					className="size-3.5 shrink-0"
				/>
			)}
			<span className="min-w-0 truncate">{group.label}</span>
			<motion.span
				aria-hidden
				initial={false}
				animate={{ rotate: collapsed ? -90 : 0 }}
				transition={reduced ? CHEVRON_TRANSITION_REDUCED : CHEVRON_TRANSITION}
				className="grid size-2.5 shrink-0 place-items-center opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none group-hover/header:opacity-70 group-focus-visible/header:opacity-70"
			>
				<IconChevronDown
					strokeWidth={3.3}
					className="size-2.5"
				/>
			</motion.span>
		</>
	);
}

function GroupRows({
	rows,
	pinned,
	archived,
	selectedUid,
	onSelect,
	onPin,
	onUnpin,
	onArchive,
	onFork,
	onInfo,
	onLeave,
	onDelete,
	onRename,
	onMoveTargets,
	onMove,
	onCompute,
}: {
	rows: SidebarRow[];
	pinned: boolean;
	archived: boolean;
	selectedUid?: SidebarRow["uid"];
	onSelect?: (row: SidebarRow) => void;
	onPin?: (row: SidebarRow) => void;
	onUnpin?: (row: SidebarRow) => void;
	onArchive?: (row: SidebarRow) => void;
	onFork?: (row: SidebarRow) => void;
	onInfo?: (row: SidebarRow) => void;
	onLeave?: (row: SidebarRow) => void;
	onDelete?: (row: SidebarRow) => void;
	onRename?: (row: SidebarRow) => void;
	onMoveTargets?: (row: SidebarRow) => Promise<MoveTarget[]>;
	onMove?: (row: SidebarRow, target: MoveTarget) => Promise<void>;
	onCompute?: (row: SidebarRow, action: "start" | "stop") => void;
}) {
	let selected = (row: SidebarRow) => isSidebarRowSelected(row, selectedUid);

	return (
		<div className={cn("px-1.5 pb-2", archived ? "pt-0" : "pt-1", archived && "opacity-70")}>
			{rows.map((row) =>
				row.lifecycle === "creating"
					? (
						<SessionItemLoading
							key={rowKey(row)}
							settled={Boolean(row.creating?.settled)}
							sessionName={row.name}
							selected={selected(row)}
						/>
					)
					: (
						<SessionItem
							key={rowKey(row)}
							data={row}
							style={row.depth
								? { paddingInlineStart: `calc(var(--spacing) * ${1 + row.depth * 3})` }
								: undefined}
							selected={selected(row)}
							pinned={pinned}
							onPin={onPin}
							onUnpin={onUnpin}
							onArchive={onArchive}
							onFork={onFork}
							onInfo={onInfo}
							onLeave={onLeave}
							onDelete={onDelete}
							onRename={onRename}
							onMoveTargets={onMoveTargets}
							onMove={onMove}
							onCompute={onCompute}
							// SessionItem is not memoized, and selecting still needs row identity.
							// Keep this local until SessionItem grows a dedicated onSelect prop.
							onClick={() => onSelect?.(row)}
						/>
					)
			)}
		</div>
	);
}

function Group({
	group,
	selectedUid,
	onSelect,
	onPin,
	onUnpin,
	onArchive,
	onArchiveInactive,
	onFork,
	onInfo,
	onLeave,
	onDelete,
	onToggleGroup,
	onNewSession,
	onContinuePr,
	onStartIssue,
	groupHeaderClassName,
	showHeader = true,
	full = false,
	onRename,
	onMoveTargets,
	onMove,
	onCompute,
}: {
	group: SessionSidebarGroup;
	selectedUid?: SidebarRow["uid"];
	onSelect?: (row: SidebarRow) => void;
	onPin?: (row: SidebarRow) => void;
	onUnpin?: (row: SidebarRow) => void;
	onArchive?: (row: SidebarRow) => void;
	onFork?: (row: SidebarRow) => void;
	onInfo?: (row: SidebarRow) => void;
	onLeave?: (row: SidebarRow) => void;
	onDelete?: (row: SidebarRow) => void;
	onRename?: (row: SidebarRow) => void;
	onMoveTargets?: (row: SidebarRow) => Promise<MoveTarget[]>;
	onMove?: (row: SidebarRow, target: MoveTarget) => Promise<void>;
	onCompute?: (row: SidebarRow, action: "start" | "stop") => void;
	onArchiveInactive?: () => void;
	onToggleGroup?: (id: SessionSidebarGroupId) => void;
	onNewSession?: () => void;
	onContinuePr?: () => void;
	onStartIssue?: () => void;
	groupHeaderClassName?: string;
	showHeader?: boolean;
	full?: boolean;
}) {
	let pinned = group.id === "pinned";
	let archived = group.id === "archived";
	let rows = useMemo(
		() =>
			pinned || group.sort === "none" || group.rows.some(row => row.depth !== undefined)
				? group.rows
				: [...group.rows].sort(byCreation),
		[group.rows, group.sort, pinned],
	);
	let onPinRow = archived ? undefined : onPin;
	let collapsed = showHeader && Boolean(group.collapsed);
	let content = useId();
	let reduced = useReducedMotion();
	let transition = reduced ? GROUP_TRANSITION_REDUCED : GROUP_TRANSITION;
	let header = useRef<HTMLDivElement>(null);
	let panel = useRef<HTMLDivElement>(null);
	let action = group.onNewSession || (group.id === "mine" ? onNewSession : undefined);
	let actionLabel = group.id.startsWith("project:")
		? `New channel in ${group.label}`
		: "New channel";
	let archiveInactive = group.id === "mine" ? onArchiveInactive : undefined;
	let create = useCallback(() => {
		if (collapsed) onToggleGroup?.(group.id);
		action?.();
	}, [action, collapsed, group.id, onToggleGroup]);
	let actionButtonClassName =
		"size-5.5 border border-transparent bg-clip-padding text-muted-foreground shadow-none hover:border-[var(--edge)] hover:bg-background/50 hover:text-sidebar-foreground hover:shadow-[0_1px_2px_rgb(0_0_0/0.08)] hover:backdrop-blur-[1px] focus-visible:border-[var(--edge)] focus-visible:bg-background/50 focus-visible:text-sidebar-foreground focus-visible:shadow-[0_1px_2px_rgb(0_0_0/0.08)] focus-visible:backdrop-blur-[1px] dark:hover:border-black/20 dark:hover:bg-background/50 dark:focus-visible:border-black/20 dark:focus-visible:bg-background/50";

	useEffect(() => {
		let button = header.current;

		if (!showHeader || !archived || collapsed) {
			if (button) delete button.dataset.shadow;
			return;
		}

		let root = panel.current;
		if (!root) return;

		let update = () => {
			if (!button) return;
			if (root.scrollTop > 0) button.dataset.shadow = "true";
			else delete button.dataset.shadow;
		};

		update();
		root.addEventListener("scroll", update, { passive: true });
		return () => root.removeEventListener("scroll", update);
	}, [archived, collapsed, rows.length, showHeader]);

	let body = (
		<GroupRows
			rows={rows}
			pinned={pinned}
			archived={archived}
			selectedUid={selectedUid}
			onSelect={onSelect}
			onPin={onPinRow}
			onUnpin={onUnpin}
			onArchive={onArchive}
			onFork={onFork}
			onInfo={onInfo}
			onLeave={onLeave}
			onDelete={onDelete}
			onRename={onRename}
			onMoveTargets={onMoveTargets}
			onMove={onMove}
			onCompute={onCompute}
		/>
	);
	let panelClassName = cn(
		"overflow-hidden",
		archived
			&& "scrollbar-muted scroll-fade min-h-0 flex-1 scrollbar-thumb-[color-mix(in_oklch,var(--color-sidebar),black_28%)] dark:scrollbar-thumb-[color-mix(in_oklch,var(--color-sidebar),white_15%)]",
	);

	return (
		<motion.section
			layout="position"
			transition={transition}
			data-group={group.id}
			className={cn(
				"relative min-w-0",
				full && "flex min-h-0 flex-1 flex-col overflow-hidden",
				archived && !full && "flex max-h-[min(45vh,18rem)] min-h-0 flex-col overflow-hidden",
			)}
		>
			{showHeader && (
				<ContextMenu disabled={!archiveInactive && !group.onRemove}>
					<ContextMenuTrigger
						render={
							<div
								ref={header}
								data-group-header
								className={cn(
									"sticky top-0 z-20 ml-[5px] mr-[3px] flex h-7 w-[calc(100%-8px)] items-center gap-1 rounded-md border border-transparent bg-transparent pr-1 pl-[9px] text-xs font-medium text-muted-foreground shadow-none transition-[background-color,border-color,box-shadow,backdrop-filter] duration-150 data-[shadow=true]:border-muted-foreground/20 data-[shadow=true]:bg-sidebar/90 data-[shadow=true]:shadow-[0_1px_2px_-1px_rgb(0_0_0/0.12),0_3px_6px_-2px_rgb(0_0_0/0.1),0_8px_14px_-10px_rgb(0_0_0/0.18)] data-[shadow=true]:backdrop-blur-lg data-[shadow=true]:hover:border-muted-foreground/25 data-[shadow=true]:hover:bg-sidebar/95 data-[shadow=true]:hover:shadow-[0_1px_2px_-1px_rgb(0_0_0/0.14),0_3px_6px_-2px_rgb(0_0_0/0.12),0_8px_14px_-10px_rgb(0_0_0/0.22)] dark:data-[shadow=true]:border-white/10 dark:data-[shadow=true]:bg-secondary/85 dark:data-[shadow=true]:shadow-[0_1px_2px_-1px_rgb(0_0_0/0.32),0_4px_8px_-4px_rgb(0_0_0/0.36)] dark:data-[shadow=true]:hover:border-white/15 dark:data-[shadow=true]:hover:bg-secondary/90 dark:data-[shadow=true]:hover:shadow-[0_1px_2px_-1px_rgb(0_0_0/0.38),0_4px_8px_-4px_rgb(0_0_0/0.44)]",
									archived && "text-muted-foreground/70",
									groupHeaderClassName,
								)}
							/>
						}
					>
						<button
							type="button"
							aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.label}`}
							aria-expanded={!collapsed}
							aria-controls={content}
							onClick={() => onToggleGroup?.(group.id)}
							className="group/header flex h-full min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-1 text-left outline-2 outline-offset-0 outline-transparent transition-colors duration-150 focus-visible:outline-ring/50"
						>
							<GroupHeaderContent
								group={group}
								collapsed={collapsed}
							/>
						</button>
						{action && (
							<div className="flex items-center gap-0.5">
								<Tooltip>
									<TooltipTrigger
										render={
											<Button
												size="icon-sm"
												variant="ghost"
												className={actionButtonClassName}
												aria-label={actionLabel}
												onClick={create}
											>
												<IconPlus className="size-3.5" />
											</Button>
										}
									/>
									<TooltipContent side="right">{actionLabel}</TooltipContent>
								</Tooltip>
								{group.id === "mine" && (
									<SessionOptions
										className={actionButtonClassName}
										onContinuePr={onContinuePr}
										onStartIssue={onStartIssue}
									/>
								)}
							</div>
						)}
					</ContextMenuTrigger>
					<ContextMenuContent className="inline-40">
						{archiveInactive && (
							<ContextMenuItem onClick={archiveInactive}>
								<IconArchive className="size-3.5" />
								Archive inactive
							</ContextMenuItem>
						)}
						{group.onRemove && (
							<ContextMenuItem onClick={group.onRemove}>
								<IconTrash className="size-3.5" />
								Remove project
							</ContextMenuItem>
						)}
					</ContextMenuContent>
				</ContextMenu>
			)}
			<AnimatePresence initial={false} mode="popLayout">
				{!collapsed && (
					<motion.div
						ref={panel}
						key="rows"
						id={content}
						layoutScroll={archived}
						layout="position"
						initial={reduced ? false : { opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={transition}
						className={panelClassName}
					>
						{body}
					</motion.div>
				)}
			</AnimatePresence>
		</motion.section>
	);
}

function LoadingRows() {
	return (
		<div aria-label="Loading channels" aria-busy="true" className="flex flex-col gap-2">
			<LoadingGroup rows={2} labelWidth="w-12" />
			<LoadingGroup rows={3} labelWidth="w-24" />
			<LoadingGroup rows={2} labelWidth="w-20" />
		</div>
	);
}

function LoadingGroup({ rows, labelWidth }: { rows: number; labelWidth: string }) {
	let placeholder = "bg-sidebar-accent/80 dark:bg-sidebar-accent";

	return (
		<section>
			<div className="flex h-7 items-center px-2 pt-1.5 pl-3.5">
				<Skeleton className={cn("h-3", placeholder, labelWidth)} />
			</div>
			<div className="pt-1 pr-1.5 pb-1 pl-2.5">
				{Array.from(
					{ length: rows },
					(_, index) => (
						<div key={index} className="flex h-8 items-center gap-1 px-1 -my-0.5">
							<Skeleton className={cn("size-4 shrink-0 rounded-sm", placeholder)} />
							<Skeleton
								className={cn(
									"h-4 min-w-0 flex-1",
									placeholder,
									index === rows - 1 && "max-w-36",
									index === 0 && "max-w-44",
								)}
							/>
						</div>
					),
				)}
			</div>
		</section>
	);
}

function DefaultEmpty({ onNewSession }: Pick<SessionSidebarProps, "onNewSession">) {
	return (
		<div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 px-6 pb-16 text-center">
			<div className="text-sm font-medium text-sidebar-foreground">No channels yet</div>
			<Button size="sm" onClick={onNewSession}>New channel</Button>
		</div>
	);
}

function ArchiveButton({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			aria-label="Show archived channels"
			onClick={onClick}
			className="group/archive mx-[5px] flex h-7 w-[calc(100%-8px)] items-center gap-2 rounded-lg squircle px-2 text-left text-xs font-medium text-muted-foreground outline-2 outline-offset-0 outline-transparent transition-[background-color,color,scale] duration-150 ease-out hover:bg-background/50 hover:text-sidebar-foreground focus-visible:outline-ring/50 active:scale-[0.96]"
		>
			<IconArchive aria-hidden className="size-3.5 shrink-0" />
			<span className="min-w-0 flex-1 truncate">Archived</span>
			<IconChevronDown
				aria-hidden
				strokeWidth={3.3}
				className="size-2.5 shrink-0 -rotate-90 opacity-60 transition-transform duration-150 ease-out group-hover/archive:translate-x-0.5"
			/>
		</button>
	);
}

function ArchivedHeader({ onBack }: { onBack: () => void }) {
	return (
		<div className="flex shrink-0 flex-col border-b border-border/60 dark:border-border/50">
			<button
				type="button"
				aria-label="Back to active channels"
				onClick={onBack}
				className="group/back mx-[5px] flex h-7 w-[calc(100%-8px)] min-w-0 items-center gap-1.5 rounded-lg squircle px-2 text-xs font-medium text-muted-foreground outline-2 outline-offset-0 outline-transparent transition-[background-color,color,scale] duration-150 ease-out hover:bg-background/50 hover:text-sidebar-foreground focus-visible:outline-ring/50 active:scale-[0.96]"
			>
				<IconChevronDown
					aria-hidden
					strokeWidth={3.3}
					className="size-2.5 shrink-0 rotate-90 opacity-70 transition-transform duration-150 ease-out group-hover/back:-translate-x-0.5"
				/>
				<span className="truncate">Back</span>
			</button>
			<div className="mx-[5px] flex h-7 w-[calc(100%-8px)] min-w-0 items-center rounded-md px-2 text-xs font-medium text-muted-foreground">
				<span className="min-w-0 truncate">Archived</span>
			</div>
		</div>
	);
}

export function ProjectSidebar({
	projectName,
	here,
	repos,
	selectedRepoId,
	onRepoChange,
	onRepoRemove,
	onAddRepo,
	onCloneRepo,
	children,
	className,
	...props
}:
	& ComponentPropsWithRef<"aside">
	& Pick<
		SessionSidebarProps,
		| "projectName"
		| "here"
		| "repos"
		| "selectedRepoId"
		| "onRepoChange"
		| "onRepoRemove"
		| "onAddRepo"
		| "onCloneRepo"
	>)
{
	return (
		<aside
			className={cn(
				"flex h-full w-64 min-w-56 flex-col overflow-hidden bg-sidebar text-sidebar-foreground select-none",
				className,
			)}
			{...props}
		>
			<header className="flex h-10.5 shrink-0 items-center border-b border-border/60 pr-2 pl-3 dark:border-transparent">
				<div className="flex min-w-0 flex-1 translate-y-0.5 items-center">
					<ProjectPicker
						projectName={projectName}
						repos={repos}
						selectedRepoId={selectedRepoId}
						onRepoChange={onRepoChange}
						onRepoRemove={onRepoRemove}
						onAddRepo={onAddRepo}
						onCloneRepo={onCloneRepo}
					/>
				</div>
				{here && <Presence members={here} />}
			</header>
			{children}
		</aside>
	);
}

function partition(groups: SessionSidebarGroup[], create: boolean) {
	let total = count(groups);
	let archived = groups.find((group) => group.id === "archived" && group.rows.length > 0);
	let visible = groups.filter((group) =>
		group.id !== "archived"
		&& (group.rows.length > 0 || group.onNewSession || (group.id === "mine" && create))
	);
	let hasCreateAction = visible.some((group) =>
		group.onNewSession || (group.id === "mine" && create)
	);
	let visibleKey = visible.map((group) =>
		`${group.id}:${group.collapsed ? 1 : 0}:${group.rows.length}`
	).join("|");
	return { total, archived, visible, hasCreateAction, visibleKey };
}

type GroupActions = Omit<ComponentPropsWithRef<typeof Group>, "group">;

function SessionRows({
	loading,
	total,
	hasCreateAction,
	empty,
	lobby,
	onRebuildLobby,
	selectLobby,
	visible,
	actions,
}: Pick<SessionSidebarProps, "loading" | "empty" | "lobby" | "onRebuildLobby"> & {
	total: number;
	hasCreateAction: boolean;
	selectLobby: () => void;
	visible: SessionSidebarGroup[];
	actions: GroupActions;
}) {
	let { onNewSession, selectedUid } = actions;
	return (loading
		? <LoadingRows />
		: total === 0 && !hasCreateAction
		? (empty ?? <DefaultEmpty onNewSession={onNewSession} />)
		: (
			<>
				{lobby && (
					<div className="pr-1.5 pl-[7px] pt-2 pb-1.5">
						<SessionItem
							data={lobby}
							selected={lobby.uid === selectedUid}
							onClick={selectLobby}
							onRebuild={onRebuildLobby}
						/>
					</div>
				)}
				{visible.map((group) => <Group key={group.id} group={group} {...actions} />)}
			</>
		));
}

export function SessionSidebar(
	{
		projectName,
		repos,
		selectedRepoId,
		groups,
		lobby,
		loading,
		selectedUid,
		onRepoChange,
		onRepoRemove,
		onSelect,
		onPin,
		onUnpin,
		onArchive,
		onArchiveInactive,
		onFork,
		onInfo,
		onLeave,
		onDelete,
		onRebuildLobby,
		onRename,
		onMoveTargets,
		onMove,
		onCompute,
		onToggleGroup,
		onNewSession,
		onContinuePr,
		onStartIssue,
		onAddRepo,
		onCloneRepo,
		groupHeaderClassName,
		empty,
		className,
		ref,
		...props
	}: SessionSidebarProps,
) {
	let { total: rows, archived, visible, hasCreateAction, visibleKey } = partition(
		groups,
		!!onNewSession,
	);
	let total = rows + (lobby ? 1 : 0);
	let hasArchived = Boolean(archived);
	let key = `${lobby ? lobby.uid : ""}|${visibleKey}`;
	let viewport = useRef<HTMLDivElement>(null);
	let reduced = useReducedMotion();
	let [view, setView] = useState<"active" | "archived">("active");
	let selectLobby = useCallback(() => {
		if (lobby) onSelect?.(lobby);
	}, [lobby, onSelect]);

	if (!hasArchived && view === "archived") setView("active");

	useEffect(() => {
		let root = viewport.current;
		if (!root) return;

		let update = () => {
			let rootRect = root.getBoundingClientRect();
			let groups = root.querySelectorAll<HTMLElement>(":scope > section[data-group]");

			for (let group of groups) {
				let header = group.querySelector<HTMLElement>(":scope > [data-group-header]");
				let button = header?.querySelector<HTMLButtonElement>("button[aria-expanded]");
				if (!header || !button || button.getAttribute("aria-expanded") !== "true") {
					if (header) delete header.dataset.shadow;
					continue;
				}

				let rect = group.getBoundingClientRect();
				let top = rect.top - rootRect.top + root.scrollTop;
				let next = root.scrollTop > top + 1 && root.scrollTop < top + group.offsetHeight - 1;
				if (next) header.dataset.shadow = "true";
				else delete header.dataset.shadow;
			}
		};

		update();
		root.addEventListener("scroll", update, { passive: true });
		window.addEventListener("resize", update, { passive: true });
		return () => {
			root.removeEventListener("scroll", update);
			window.removeEventListener("resize", update);
		};
	}, [key]);

	let actions: GroupActions = {
		selectedUid,
		onSelect,
		onPin,
		onUnpin,
		onArchive,
		onArchiveInactive,
		onFork,
		onInfo,
		onLeave,
		onDelete,
		onRename,
		onMoveTargets,
		onMove,
		onCompute,
		onToggleGroup,
		onNewSession,
		onContinuePr,
		onStartIssue,
		groupHeaderClassName,
	};

	return (
		<TooltipProvider>
			<ProjectSidebar
				ref={ref}
				className={className}
				projectName={projectName}
				repos={repos}
				selectedRepoId={selectedRepoId}
				onRepoChange={onRepoChange}
				onRepoRemove={onRepoRemove}
				onAddRepo={onAddRepo}
				onCloneRepo={onCloneRepo}
				{...props}
			>
				<div className="relative min-h-0 flex-1 overflow-hidden">
					<motion.div
						initial={false}
						animate={{ x: view === "archived" ? "-100%" : "0%" }}
						transition={reduced ? PANE_TRANSITION_REDUCED : PANE_TRANSITION}
						className="flex h-full min-h-0 w-full"
					>
						<div
							aria-hidden={view !== "active"}
							inert={view !== "active" ? true : undefined}
							className="flex h-full min-h-0 w-full shrink-0 flex-col"
						>
							<motion.div
								ref={viewport}
								layoutScroll
								className="scrollbar-muted scroll-fade min-h-0 flex-1 scrollbar-thumb-[color-mix(in_oklch,var(--color-sidebar),black_28%)] dark:scrollbar-thumb-[color-mix(in_oklch,var(--color-sidebar),white_15%)]"
							>
								<SessionRows
									loading={loading}
									total={total}
									hasCreateAction={hasCreateAction}
									empty={empty}
									lobby={lobby}
									onRebuildLobby={onRebuildLobby}
									selectLobby={selectLobby}
									visible={visible}
									actions={actions}
								/>
							</motion.div>
							{!loading && total > 0 && archived && (
								<div className="shrink-0 border-t border-border/70 pt-1 pb-2 dark:border-border/50">
									<ArchiveButton onClick={() => setView("archived")} />
								</div>
							)}
						</div>
						<div
							aria-hidden={view !== "archived"}
							inert={view !== "archived" ? true : undefined}
							className="flex h-full min-h-0 w-full shrink-0 flex-col"
						>
							{archived && (
								<>
									<ArchivedHeader onBack={() => setView("active")} />
									<Group group={archived} {...actions} showHeader={false} full />
								</>
							)}
						</div>
					</motion.div>
				</div>
			</ProjectSidebar>
		</TooltipProvider>
	);
}
