import { type ActionProps, canTogglePin } from "./actions";
import type { MouseEvent, ReactNode } from "react";
import { useRef, useState } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";

import { motion } from "../../ui/popup";

import type { MoveTarget, SidebarRow } from "./session-item.types";
import {
	IconArchive as ArchiveContent2,
	IconArchiveRestore as Unarchive,
	IconCloud as Cloud,
	IconExit as Leave,
	IconFork as Fork,
	IconHash as Hash,
	IconInfo as Info,
	IconPencil as Pencil,
	IconPin as Pin,
	IconPinOff as PinSlash,
	IconPlay as Play,
	IconRotate as Rebuild,
	IconStop as Stop,
	IconTrash as Trash,
} from "../../icons";

const MENU_POPUP =
	"z-50 max-block-(--available-height) min-inline-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-(--r-popover) squircle bg-popover p-1 text-popover-foreground shadow-popover outline-none";
const MENU_POPUP_FULL = `${MENU_POPUP} ${motion}`;
const MENU_ITEM =
	"relative flex min-h-7 cursor-default items-center gap-2 rounded-md squircle px-2 py-1 text-xs/relaxed outline-hidden select-none focus:bg-secondary focus:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5";
const MENU_ITEM_DESTRUCTIVE =
	"text-destructive focus:bg-destructive/10 focus:text-destructive dark:focus:bg-destructive/20";
const MENU_ITEM_DESTRUCTIVE_FULL = `${MENU_ITEM} ${MENU_ITEM_DESTRUCTIVE}`;
const MENU_SEPARATOR = "-mx-1 my-1 h-px bg-border/50";

type RowMenuProps = ActionProps & {
	data: SidebarRow;
	onRename?: (data: SidebarRow) => void;
	onFork?: (data: SidebarRow) => void;
	onInfo?: (data: SidebarRow) => void;
	onLeave?: (data: SidebarRow) => void;
	onArchive?: (data: SidebarRow) => void;
	onDelete?: (data: SidebarRow) => void;
	onRebuild?: (data: SidebarRow) => void;
	onMoveTargets?: (data: SidebarRow) => Promise<MoveTarget[]>;
	onMove?: (data: SidebarRow, target: MoveTarget) => Promise<void>;
	onCompute?: (data: SidebarRow, action: "start" | "stop") => void;
	children: ReactNode;
};

const PLACES = { local: Hash, hosted: Cloud, cloud: Cloud };
// "Cloud" and "cloud workspace" alone don't say what moves, so each item says where tools run.
const HINTS = {
	local: "Chat and tools run on this Mac",
	hosted: "Chat moves; tools stay on this Mac",
	cloud: "Chat and tools move to a cloud container",
};

type Destinations =
	| { state: "loading" }
	| { state: "ready"; targets: MoveTarget[] }
	| { state: "error" };

function stop(event: MouseEvent<HTMLElement>) {
	event.stopPropagation();
}

function MoveSection(
	{ destinations, moving, onMove }: {
		destinations: Destinations;
		moving?: string;
		onMove: (target: MoveTarget) => void;
	},
) {
	return (
		<>
			<ContextMenu.Separator className={MENU_SEPARATOR} />
			<ContextMenu.Group>
				{destinations.state === "loading" && (
					<ContextMenu.Item className={MENU_ITEM} disabled>Loading destinations…</ContextMenu.Item>
				)}
				{destinations.state === "error" && (
					<ContextMenu.Item className={MENU_ITEM} disabled>
						Couldn't load destinations
					</ContextMenu.Item>
				)}
				{destinations.state === "ready" && destinations.targets.length === 0 && (
					<ContextMenu.Item className={MENU_ITEM} disabled>
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="truncate">Move to… no available destinations</span>
							<span className="text-muted-foreground">
								Cloud compute and a GitHub repository let a channel move
							</span>
						</span>
					</ContextMenu.Item>
				)}
				{destinations.state === "ready" && destinations.targets.map((target) => {
					const Icon = PLACES[target.place];
					return (
						<ContextMenu.Item
							key={target.target}
							className={MENU_ITEM}
							disabled={Boolean(moving)}
							onClick={(event) => {
								stop(event);
								onMove(target);
							}}
						>
							<Icon className="size-3.5 self-start mt-0.5" />
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate">Move to {target.label}</span>
								<span className="truncate text-muted-foreground">{HINTS[target.place]}</span>
							</span>
							{moving === target.target && (
								<span className="shrink-0 text-muted-foreground">Moving…</span>
							)}
						</ContextMenu.Item>
					);
				})}
			</ContextMenu.Group>
			<ContextMenu.Separator className={MENU_SEPARATOR} />
		</>
	);
}

export function RowMenu(
	{
		data,
		pinned,
		onPin,
		onUnpin,
		onRename,
		onFork,
		onInfo,
		onLeave,
		onArchive,
		onDelete,
		onRebuild,
		onMoveTargets,
		onMove,
		onCompute,
		children,
	}: RowMenuProps,
) {
	let anchor = useRef<HTMLDivElement>(null);
	let request = useRef(0);
	let [open, setOpen] = useState(false);
	let [primary, setPrimary] = useState(true);
	let [destinations, setDestinations] = useState<Destinations>({ state: "loading" });
	let [moving, setMoving] = useState<string>();
	let lobby = data.kind === "lobby";
	let archived = data.lifecycle === "archived";
	let movable = onMoveTargets && onMove;

	let leave = data.member ? onLeave : undefined;
	let canPin = canTogglePin({ pinned, onPin, onUnpin });
	// Actions that can't succeed on this row are hidden, so a row may be left with none to offer.
	let offered = lobby
		? Boolean(onRebuild)
		: archived
		? Boolean(onArchive || onDelete)
		: Boolean(canPin || onRename || onFork || onInfo || leave || movable || onCompute || onArchive);

	function pin(event: MouseEvent<HTMLElement>) {
		stop(event);
		if (pinned) onUnpin?.(data);
		else onPin?.(data);
	}

	function rename(event: MouseEvent<HTMLElement>) {
		stop(event);
		onRename?.(data);
	}

	function fork(event: MouseEvent<HTMLElement>) {
		stop(event);
		onFork?.(data);
	}

	function info(event: MouseEvent<HTMLElement>) {
		stop(event);
		onInfo?.(data);
	}

	function exit(event: MouseEvent<HTMLElement>) {
		stop(event);
		leave?.(data);
	}

	function archive(event: MouseEvent<HTMLElement>) {
		stop(event);
		onArchive?.(data);
	}

	function del(event: MouseEvent<HTMLElement>) {
		stop(event);
		onDelete?.(data);
	}

	function compute(event: MouseEvent<HTMLElement>, action: "start" | "stop") {
		stop(event);
		onCompute?.(data, action);
	}

	function rebuild(event: MouseEvent<HTMLElement>) {
		stop(event);
		onRebuild?.(data);
	}

	// Destinations depend on live services and idleness, so each opening asks again.
	function change(next: boolean) {
		setOpen(next);
		if (!next || !onMoveTargets) return;
		let id = ++request.current;
		setDestinations({ state: "loading" });
		onMoveTargets(data).then(
			(targets) => {
				if (id === request.current) setDestinations({ state: "ready", targets });
			},
			() => {
				if (id === request.current) setDestinations({ state: "error" });
			},
		);
	}

	function move(target: MoveTarget) {
		if (moving || !onMove) return;
		setMoving(target.target);
		onMove(data, target).finally(() => setMoving(undefined));
	}

	return (
		<ContextMenu.Root disabled={!offered} onOpenChange={change}>
			<ContextMenu.Trigger
				render={
					<div
						ref={anchor}
						data-menu-open={open ? "true" : undefined}
						data-primary={primary}
						onPointerDownCapture={event => setPrimary(event.button === 0 && !event.ctrlKey)}
						onKeyDownCapture={() => setPrimary(true)}
						className="group/menu"
					/>
				}
			>
				{children}
			</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Positioner
					anchor={anchor}
					side="bottom"
					align="end"
					sideOffset={4}
					alignOffset={0}
					className="isolate z-50 outline-none"
				>
					<ContextMenu.Popup data-slot="context-menu-content" className={MENU_POPUP_FULL}>
						{!lobby && !archived && (
							<>
								<ContextMenu.Group>
									{canPin && (
										<ContextMenu.Item className={MENU_ITEM} onClick={pin}>
											{pinned ? <PinSlash className="size-3.5" /> : <Pin className="size-3.5" />}
											{pinned ? "Unpin channel" : "Pin channel"}
										</ContextMenu.Item>
									)}
									{onRename && (
										<ContextMenu.Item className={MENU_ITEM} onClick={rename}>
											<Pencil className="size-3.5" />
											Rename channel
										</ContextMenu.Item>
									)}
									{onFork && (
										<ContextMenu.Item className={MENU_ITEM} onClick={fork}>
											<Fork className="size-3.5" />
											Fork channel
										</ContextMenu.Item>
									)}
									{onInfo && (
										<ContextMenu.Item className={MENU_ITEM} onClick={info}>
											<Info className="size-3.5" />
											Channel info
										</ContextMenu.Item>
									)}
									{leave && (
										<ContextMenu.Item className={MENU_ITEM} onClick={exit}>
											<Leave className="size-3.5" />
											Leave channel
										</ContextMenu.Item>
									)}
								</ContextMenu.Group>
								{movable && (
									<MoveSection destinations={destinations} moving={moving} onMove={move} />
								)}
								{onCompute && (
									<>
										<ContextMenu.Separator className={MENU_SEPARATOR} />
										<ContextMenu.Group>
											{data.stopped
												? (
													<ContextMenu.Item
														className={MENU_ITEM}
														onClick={(event) => compute(event, "start")}
													>
														<Play className="size-3.5" />
														Start compute
													</ContextMenu.Item>
												)
												: (
													<ContextMenu.Item
														className={MENU_ITEM}
														onClick={(event) => compute(event, "stop")}
													>
														<Stop className="size-3.5" />
														Stop compute
													</ContextMenu.Item>
												)}
										</ContextMenu.Group>
										<ContextMenu.Separator className={MENU_SEPARATOR} />
									</>
								)}
								{onArchive && (
									<ContextMenu.Item className={MENU_ITEM_DESTRUCTIVE_FULL} onClick={archive}>
										<ArchiveContent2 className="size-3.5" />
										Archive channel
									</ContextMenu.Item>
								)}
								{onDelete && (
									<ContextMenu.Item className={MENU_ITEM_DESTRUCTIVE_FULL} disabled>
										<Trash className="size-3.5" />
										Delete channel
										<span className="ml-auto pl-3 text-muted-foreground">Archive first</span>
									</ContextMenu.Item>
								)}
							</>
						)}
						{!lobby && archived && (
							<>
								{onArchive && (
									<ContextMenu.Item className={MENU_ITEM} onClick={archive}>
										<Unarchive className="size-3.5" />
										Unarchive channel
									</ContextMenu.Item>
								)}
								{onDelete && (
									<ContextMenu.Item className={MENU_ITEM_DESTRUCTIVE_FULL} onClick={del}>
										<Trash className="size-3.5" />
										Delete channel
									</ContextMenu.Item>
								)}
							</>
						)}
						{lobby && onRebuild && (
							<ContextMenu.Item className={MENU_ITEM_DESTRUCTIVE_FULL} onClick={rebuild}>
								<Rebuild className="size-3.5" />
								Rebuild Lobby
							</ContextMenu.Item>
						)}
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}
