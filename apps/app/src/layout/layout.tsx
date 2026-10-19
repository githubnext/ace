import {
	type ComponentType,
	type CSSProperties,
	type KeyboardEvent,
	type MouseEvent,
	type PointerEvent,
	type ReactNode,
	type Ref,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal, flushSync } from "react-dom";

import type { TabRename, WindowState } from "@ace/host/protocol";
import * as Split from "@ace/split-tabs";
import {
	Button,
	ContextMenu,
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuTrigger,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ace/ui";
import {
	IconFileDiff,
	IconMessage,
	IconPencil,
	IconPlus,
	IconRows,
	IconSplitView,
	IconTerminal,
	IconX,
} from "@ace/ui/icons";

import { isFocused, subscribe as onFocus } from "../focus";
import { host } from "../host";
import { Bar as Header } from "./bar";
import { Grip } from "./grip";
import { Rename } from "./rename";
import {
	CHAT,
	type Content,
	content,
	fallback,
	type Kind,
	type Meta,
	read,
	write,
} from "./storage";
import { type DndDrag, type DndDrop, useDnd } from "./use-dnd";
import { useResize } from "./use-resize";

export { CHAT, type Content };

/** The mounted channel's tabs, for switchers outside its tree; a window shows one channel. */
export const switcher: { current?: { window: () => WindowState; show: (uid: string) => void } } =
	{};

type Icon = ComponentType<{ className?: string }>;
type Choice = Exclude<Kind, "blank">;

type Item = {
	uid: string;
	name: string;
	kind: Kind;
	chat: boolean;
	icon: Icon;
};

/** Renders a tab's content; `update` merges into the tab's persisted content. */
export type Render = (
	data: Content,
	uid: string,
	active: boolean,
	update: (patch: Partial<Content>) => void,
) => ReactNode;

type Props = {
	/** Where the layout persists: one per channel. */
	id: string;
	name: string;
	/** The Chat tab's icon, which marks where the channel runs. */
	icon?: Icon;
	/** The chat new Diff and Terminal tabs show. */
	chat: number;
	/** Whether the chat's lane has changes, once known. */
	changed?: boolean;
	render: Render;
	/** Channel controls immediately before the header's new-tab button. */
	actions?: ReactNode;
	/** Notified when a tab is closed, so owners can release its resources. */
	onTabClose?: (uid: string, data: Content) => void;
	/** Receives the function that shows the chat's Diff tab, opening one beside the chat if needed. */
	opener?: { current?: () => void };
};

const MIN = 350;
const CHAT_MIN = 450;
// The old app also offered Plan, Browse, and Browser Preview; they return when their backends do.
const CHOICES: Choice[] = ["chat", "diff", "terminal"];
const ICONS: Record<Kind, Icon> = {
	blank: IconSplitView,
	chat: IconMessage,
	diff: IconFileDiff,
	terminal: IconTerminal,
};
const TITLES: Record<Kind, string> = {
	blank: "Blank",
	chat: "Chat",
	diff: "Diff",
	terminal: "Terminal",
};

function minimum(tab?: Split.Tab) {
	return tab === CHAT ? CHAT_MIN : MIN;
}

function title(uid: string, name: string, data: Content, count = 1, total = 1) {
	if (uid === CHAT) return name;
	if (data.name) return data.name;
	const label = TITLES[data.type];
	return total > 1 ? `${label} ${count}` : label;
}

function item(
	uid: string,
	name: string,
	icon: Icon,
	data: Content = fallback(uid),
	count?: number,
	total?: number,
): Item {
	return {
		uid,
		name: title(uid, name, data, count, total),
		kind: data.type,
		chat: uid === CHAT,
		icon: uid === CHAT ? icon : ICONS[data.type],
	};
}

function list(tabs: string[], name: string, icon: Icon, meta: Meta) {
	const totals = new Map<Kind, number>();
	for (const uid of tabs) {
		if (uid === CHAT) continue;
		const type = (meta[uid] || fallback(uid)).type;
		totals.set(type, (totals.get(type) || 0) + 1);
	}

	const counts = new Map<Kind, number>();
	return new Map(tabs.map((uid) => {
		const value = meta[uid] || fallback(uid);
		const count = uid === CHAT ? 1 : (counts.get(value.type) || 0) + 1;
		counts.set(value.type, count);
		return [uid, item(uid, name, icon, value, count, totals.get(value.type))];
	}));
}

function hint(side?: Split.Side) {
	if (side === "left") return "inset-y-2 left-2 w-1/2";
	if (side === "right") return "inset-y-2 right-2 w-1/2";
	if (side === "top") return "inset-x-2 top-2 h-1/2";
	if (side === "bottom") return "inset-x-2 bottom-2 h-1/2";
	return "inset-2";
}

function top(pane: Split.Pane) {
	return pane.area[0][0] === "RS";
}

function column(pane: Split.Pane) {
	const col = pane.area[1];
	return `${col[0]} / ${col[1]}`;
}

function focus(uid: string) {
	document.querySelector<HTMLElement>(`[data-layout-tab="${CSS.escape(uid)}"]`)?.focus();
}

function Blank({ item, onChoose }: { item: Item; onChoose: (choice: Choice) => void }) {
	const Icon = item.icon;

	if (item.kind === "blank") {
		return (
			<div className="flex h-full min-h-0 items-center justify-center px-4 contain-content">
				<div className="scrollbar-muted flex max-h-full min-w-0 flex-col overflow-y-auto py-2 contain-style">
					{CHOICES.map((choice) => {
						const Icon = ICONS[choice];
						return (
							<Button
								key={choice}
								type="button"
								variant="ghost"
								size="lg"
								className="w-56 justify-start text-muted-foreground hover:text-foreground"
								onClick={() => onChoose(choice)}
							>
								<Icon data-icon="inline-start" aria-hidden />
								<span className="min-w-0 flex-1 truncate text-left">{TITLES[choice]}</span>
							</Button>
						);
					})}
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 px-4 text-sm font-medium text-muted-foreground contain-content">
			<span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground contain-strict">
				<Icon aria-hidden className="size-4" />
			</span>
			<span className="max-w-full truncate">{item.name}</span>
		</div>
	);
}

function Add({ onAdd }: { onAdd: (choice: Choice) => void }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label="New tab"
						className="mr-2 ml-0.5 shrink-0 text-muted-foreground electrobun-webkit-app-region-no-drag"
					/>
				}
			>
				<IconPlus aria-hidden />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				sideOffset={6}
				className="scrollbar-muted max-h-80 w-56 overflow-y-auto"
			>
				<DropdownMenuGroup>
					{CHOICES.map((choice) => {
						const Icon = ICONS[choice];
						return (
							<DropdownMenuItem key={choice} onClick={() => onAdd(choice)}>
								<Icon
									aria-hidden
									className="size-3.5 text-muted-foreground group-focus/dropdown-menu-item:text-popover-foreground"
								/>
								<span className="min-w-0 flex-1 truncate">{TITLES[choice]}</span>
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function Ghost({ item, drag, ref }: { item: Item; drag: DndDrag; ref: Ref<HTMLDivElement> }) {
	const Icon = item.icon;

	return (
		<div
			ref={ref}
			data-layout-preview
			className="pointer-events-none fixed top-0 left-0 z-50 flex h-8 max-w-44 items-center gap-1.5 rounded-md border border-border bg-background/95 px-3 text-xs font-medium text-foreground opacity-95 shadow-lg backdrop-blur contain-layout"
			style={{ transform: `translate3d(${drag.x}px, ${drag.y}px, 0)` }}
		>
			<Icon aria-hidden className="size-3.5 shrink-0" />
			<span className="truncate">{item.name}</span>
		</div>
	);
}

function Tool({
	label,
	tip,
	disabled,
	children,
	onClick,
}: {
	label: string;
	tip: string;
	disabled: boolean;
	children: ReactNode;
	onClick: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span className="inline-flex shrink-0">
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={label}
							disabled={disabled}
							className="shrink-0 text-muted-foreground"
							onClick={onClick}
						>
							{children}
						</Button>
					</span>
				}
			/>
			<TooltipContent>{tip}</TooltipContent>
		</Tooltip>
	);
}

function Tools({
	split,
	can,
}: {
	split: (side: "right" | "bottom") => void;
	can: (side: "right" | "bottom") => boolean;
}) {
	const right = can("right");
	const down = can("bottom");

	return (
		<div className="ml-auto flex h-full shrink-0 items-center border-l border-border px-1 contain-style electrobun-webkit-app-region-no-drag">
			<Tool
				label="Split right"
				tip={right ? "Split right" : "Too little space"}
				disabled={!right}
				onClick={() => split("right")}
			>
				<IconSplitView aria-hidden />
			</Tool>
			<Tool
				label="Split down"
				tip={down ? "Split down" : "Too little space"}
				disabled={!down}
				onClick={() => split("bottom")}
			>
				<IconRows aria-hidden />
			</Tool>
		</div>
	);
}

type TabProps = {
	item: Item;
	pane: string;
	selected: boolean;
	dragging: boolean;
	insert: boolean;
	flat: boolean;
	onSelect: (id: string) => void;
	onClose: (id: string) => void;
	onRename: (id: string, name: string) => void;
	onStart: (event: PointerEvent<HTMLElement>, id: string) => void;
	onNav: (event: KeyboardEvent<HTMLElement>) => void;
};

function Tab({
	item,
	pane,
	selected,
	dragging,
	insert,
	flat,
	onSelect,
	onClose,
	onRename,
	onStart,
	onNav,
}: TabProps) {
	const id = item.uid;
	const Icon = item.icon;
	const [open, setOpen] = useState(false);

	function rename(event: MouseEvent<HTMLElement>) {
		event.stopPropagation();
		if (item.chat) return;
		setOpen(true);
	}

	function close(event: MouseEvent<HTMLElement>) {
		event.stopPropagation();
		if (item.chat) return;
		onClose(id);
	}

	function cancel() {
		setOpen(false);
		requestAnimationFrame(() => focus(id));
	}

	function save(name: string) {
		if (item.chat) return;
		onRename(id, name);
		setOpen(false);
	}

	const tab = (
		<div
			role="tab"
			id={`tab-${id}`}
			aria-selected={selected}
			aria-controls={`panel-${id}`}
			tabIndex={selected ? 0 : -1}
			data-layout-tab={id}
			data-layout-pane={pane}
			data-active={selected || undefined}
			data-dragging={dragging || undefined}
			className={`relative flex h-8 max-w-40 shrink-0 touch-none items-center gap-1.5 border-r border-border pr-3 pl-3 text-xs font-medium text-muted-foreground outline-none contain-style touch:pr-1 data-active:bg-background data-active:text-foreground ${
				flat ? "cursor-default" : "cursor-default data-dragging:cursor-grabbing"
			}`}
			onClick={(event) => {
				event.preventDefault();
				onSelect(id);
			}}
			onKeyDown={(event) => {
				if (!item.chat && (event.key === "Backspace" || event.key === "Delete")) {
					event.preventDefault();
					return onClose(id);
				}
				onNav(event);
			}}
			onPointerDown={(event) => onStart(event, id)}
		>
			{insert && (
				<span
					data-layout-insert
					className="pointer-events-none absolute top-1 -left-px z-10 h-6 w-0.5 rounded-full bg-primary"
				/>
			)}
			<span className="relative flex size-3.5 shrink-0 items-center justify-center">
				<Icon
					aria-hidden
					className={`size-3.5 transition-opacity duration-150 ${
						item.chat
							? ""
							: "opacity-0 notouch:opacity-100 notouch:group-hover/tab:opacity-0 group-has-focus-visible/tab:opacity-0"
					}`}
				/>
			</span>
			<span className="min-w-0 flex-1 truncate">{item.name}</span>
		</div>
	);

	return (
		<>
			<ContextMenu>
				<div
					role="presentation"
					data-dragging={dragging || undefined}
					className="group/tab relative flex max-w-40 shrink-0 electrobun-webkit-app-region-no-drag data-dragging:opacity-40"
				>
					<ContextMenuTrigger render={tab} />
					{!item.chat && (
						<button
							type="button"
							aria-label={`Close ${item.name}`}
							tabIndex={-1}
							className="group/x absolute top-1/2 left-[19px] inline-flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center opacity-100 transition-opacity duration-150 notouch:opacity-0 notouch:group-hover/tab:opacity-100 group-has-focus-visible/tab:opacity-100"
							onPointerDown={(event) => event.stopPropagation()}
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();
								onClose(id);
							}}
						>
							<span className="inline-flex size-4 items-center justify-center rounded-md text-muted-foreground transition-colors group-hover/x:bg-muted/60 group-hover/x:text-foreground">
								<IconX aria-hidden className="size-3" />
							</span>
						</button>
					)}
				</div>
				<ContextMenuContent sideOffset={4} className="w-36">
					<ContextMenuGroup>
						<ContextMenuItem disabled={item.chat} onClick={rename}>
							<IconPencil aria-hidden />
							Rename
						</ContextMenuItem>
						<ContextMenuItem disabled={item.chat} onClick={close}>
							<IconX aria-hidden />
							Close
						</ContextMenuItem>
					</ContextMenuGroup>
				</ContextMenuContent>
			</ContextMenu>
			<Rename open={open} name={item.name} onSave={save} onCancel={cancel} />
		</>
	);
}

type BarProps = {
	actions?: ReactNode;
	pane: Split.Pane;
	items: Map<string, Item>;
	flat: boolean;
	drag?: DndDrag;
	drop?: DndDrop;
	edge?: boolean;
	line?: boolean;
	start?: boolean;
	end?: boolean;
	style?: CSSProperties;
	onFork: (side: "right" | "bottom") => void;
	can: (side: "right" | "bottom") => boolean;
	onSelect: (id: string) => void;
	onAdd: (choice: Choice) => void;
	onClose: (id: string) => void;
	onRename: (id: string, name: string) => void;
	onStart: (event: PointerEvent<HTMLElement>, id: string) => void;
	onNav: (event: KeyboardEvent<HTMLElement>, pane: Split.Pane) => void;
};

function Bar({
	actions,
	pane,
	items,
	flat,
	drag,
	drop,
	edge,
	line = true,
	start,
	end,
	style,
	onFork,
	can,
	onSelect,
	onAdd,
	onClose,
	onRename,
	onStart,
	onNav,
}: BarProps) {
	const before = drop?.kind === "tab" ? drop.before : undefined;

	return (
		<div
			className={`flex h-8 min-w-0 shrink-0 items-center overflow-hidden bg-muted/45 contain-style ${
				edge
					? "relative before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:z-10 before:w-px before:-translate-x-1/2 before:bg-border before:content-['']"
					: ""
			} ${line ? "border-b border-border" : ""} ${start ? "pl-8" : ""} ${end ? "pr-8" : ""}`}
			style={style}
		>
			<div
				role="tablist"
				data-layout-tabs
				data-axis="x"
				data-layout-pane={pane.uid}
				className="scroll-fade scrollbar-none flex h-full min-w-0 flex-1 items-center contain-style"
			>
				{pane.tabs.map((id) => {
					const item = items.get(id);
					if (!item) return null;
					return (
						<Tab
							key={id}
							item={item}
							pane={pane.uid}
							selected={pane.active === id}
							dragging={drag?.uid === id}
							insert={before === id}
							flat={flat}
							onSelect={onSelect}
							onClose={onClose}
							onRename={onRename}
							onStart={onStart}
							onNav={(event) => onNav(event, pane)}
						/>
					);
				})}
				{drop?.kind === "bar" && (
					<span
						data-layout-insert
						className="pointer-events-none mx-0.5 h-6 w-0.5 shrink-0 rounded-full bg-primary"
					/>
				)}
			</div>
			{actions}
			<Add onAdd={onAdd} />
			{!flat && <Tools split={onFork} can={can} />}
		</div>
	);
}

type PaneProps = BarProps & {
	meta: Meta;
	focused: boolean;
	header: boolean;
	render: Render;
	onFocus: () => void;
	onChoose: (uid: string, choice: Choice) => void;
	onUpdate: (uid: string, patch: Partial<Content>) => void;
};

function Pane(props: PaneProps) {
	const { pane, items, meta, focused, drop, header, render, onFocus, onChoose, onUpdate } = props;
	const hover = drop?.kind === "pane" ? drop : undefined;
	const blocked = !!hover?.side && !hover.valid;

	return (
		<section
			data-active={focused || undefined}
			className="group/pane relative flex min-h-0 flex-col overflow-hidden bg-background contain-content"
			style={{ gridArea: Split.place(pane) }}
			onFocusCapture={onFocus}
		>
			{!header && <Bar {...props} />}
			<div
				data-layout-zone
				data-layout-pane={pane.uid}
				className="relative min-h-0 flex-1 contain-style"
			>
				{pane.tabs.map((id) => {
					const item = items.get(id);
					if (!item) return null;
					const active = pane.active === id;
					const data = meta[id] || fallback(id);
					const node = data.type === "blank"
						? null
						: render(data, id, active, (patch) => onUpdate(id, patch));
					return (
						<div
							key={id}
							role="tabpanel"
							id={`panel-${id}`}
							aria-labelledby={`tab-${id}`}
							tabIndex={active ? 0 : -1}
							inert={!active}
							className={`absolute inset-0 flex min-h-0 flex-col overflow-hidden outline-none contain-content ${
								active ? "" : "pointer-events-none invisible"
							}`}
						>
							{node || <Blank item={item} onChoose={(choice) => onChoose(id, choice)} />}
						</div>
					);
				})}
				{hover && (
					<div
						data-layout-drop={hover.side || "center"}
						className={`pointer-events-none absolute z-20 flex items-center justify-center rounded-md border text-xs font-medium backdrop-blur-sm contain-content ${
							blocked
								? "border-muted-foreground/45 bg-muted/30 text-muted-foreground"
								: "border-primary bg-primary/20"
						} ${hint(hover.side)}`}
					>
						{blocked && "Too small"}
					</div>
				)}
			</div>
		</section>
	);
}

function useLayout({ id, name, icon = ICONS.chat, chat, changed, onTabClose, opener }: Props) {
	const [data] = useState(() => read(id));
	const [api] = useState(() => Split.create(data.state, { min: minimum }));
	const [meta, setMeta] = useState<Meta>(data.meta);
	const [diff, setDiff] = useState(data.diff);
	const state = useSyncExternalStore(api.subscribe, api.get, api.get);
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const focused = useSyncExternalStore(onFocus, isFocused);
	const { view, css, grips, grid, flat, desktop, box, start: resize } = useResize(
		api,
		state,
		minimum,
	);
	const fit = { width: box.width, height: box.height, min: minimum } satisfies Split.Fit;
	const dnd = useDnd(api, flat, fit);
	const items = list(view.tabs, name, icon, meta);
	const ghost = dnd.drag;
	const drag = ghost
		? items.get(ghost.uid) || item(ghost.uid, name, icon, meta[ghost.uid])
		: undefined;

	useEffect(() => {
		write(id, state, meta, diff);
	}, [id, state, meta, diff]);

	const snapshot = useEffectEvent((): WindowState => {
		const active = new Set(view.panes.map((pane) => pane.active));
		return {
			channel: { id, name },
			tabs: [...items.values()].map((item) => ({
				id: item.uid,
				name: item.name,
				type: item.kind,
				active: active.has(item.uid),
			})),
			focused,
		};
	});
	const persist = useEffectEvent(() => write(id, api.get(), meta, diff));
	const command = useEffectEvent((request: TabRename) => {
		if (request.expires <= Date.now()) throw new Error("Tab rename expired");
		if (request.channel !== id) throw new Error("This window is showing another channel");
		if (!api.get().tabs.includes(request.tab)) throw new Error("Tab is no longer open");
		if (request.tab === CHAT) throw new Error("Rename the channel to change its Chat tab");
		// The host must acknowledge the name that the client has actually rendered and saved.
		flushSync(() => rename(request.tab, request.name, false));
		persist();
		return snapshot();
	});

	const show = useEffectEvent((uid: string) => activate(uid));

	useLayoutEffect(() => {
		host.onRename = command;
		switcher.current = { window: snapshot, show };
		return () => {
			host.onRename = undefined;
			switcher.current = undefined;
			host.request({ op: "window", value: null }).catch(() => {});
		};
	}, []);

	useEffect(() => {
		if (status !== "open") return;
		host.request({ op: "window", value: snapshot() }).catch(() => {});
	}, [id, name, state, meta, flat, status, focused]);

	// New changes open a Diff tab behind the Chat tab once; closing it keeps it closed until the
	// changes clear and new ones appear.
	useEffect(() => {
		if (changed === undefined) return;
		if (!changed) return setDiff(false);
		if (diff) return;
		setDiff(true);
		if (Object.values(meta).some((value) => value.type === "diff" && value.chat === chat)) return;
		const uid = `tab-${api.get().seq + 1}`;
		const pane = Split.host(api.get(), CHAT)?.uid;
		if (!api.open({ tab: uid, to: { pane }, background: true })) return;
		setMeta((meta) => ({ ...meta, [uid]: content("diff", chat) }));
	}, [api, chat, changed, diff, meta]);

	const reveal = useEffectEvent(() => {
		const tabs = api.get().tabs;
		const uid = tabs.find((uid) => {
			const value = meta[uid];
			return value?.type === "diff" && value.chat === chat;
		});
		if (uid) return activate(uid);
		const pane = Split.host(api.get(), CHAT);
		if (pane) add(pane, "diff");
	});

	useLayoutEffect(() => {
		if (!opener) return;
		opener.current = reveal;
		return () => void (opener.current = undefined);
	}, [opener]);

	function nav(event: KeyboardEvent<HTMLElement>, pane: Split.Pane) {
		const tabs = pane.tabs;
		if (tabs.length < 2) return;

		const i = pane.active ? tabs.indexOf(pane.active) : 0;
		let next = i;
		if (event.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
		else if (event.key === "ArrowRight") next = (i + 1) % tabs.length;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = tabs.length - 1;
		else return;

		event.preventDefault();
		const uid = tabs[next]!;
		api.select({ tab: uid, pane: flat ? undefined : pane.uid });
		focus(uid);
	}

	const heads = view.panes.filter(top);
	const frame = {
		gridTemplateColumns: css.gridTemplateColumns,
		gridTemplateRows: "2rem minmax(0, 1fr)",
	} satisfies CSSProperties;
	const body = {
		gridColumn: "1 / -1",
		gridRow: "2",
		gridTemplateColumns: "subgrid",
		gridTemplateRows: css.gridTemplateRows,
	} satisfies CSSProperties;

	function choose(uid: string, pane: Split.Pane) {
		if (dnd.consume()) return;
		api.select({ tab: uid, pane: flat ? undefined : pane.uid });
	}

	function allow(pane: Split.Pane, side: "right" | "bottom") {
		return Split.can(state, { ...fit, open: { to: { pane: pane.uid, side } } });
	}

	function activate(uid: string) {
		const pane = Split.host(api.get(), uid);
		api.select({ tab: uid, pane: flat ? undefined : pane?.uid });
		requestAnimationFrame(() => focus(uid));
	}

	function add(pane: Split.Pane, choice: Choice | "blank", side?: "right" | "bottom") {
		// There is one Chat tab per chat, so choosing Chat shows it rather than opening another.
		if (choice === "chat") return activate(CHAT);
		const uid = `tab-${api.get().seq + 1}`;
		const to: Split.Target | undefined = side
			? { pane: pane.uid, side }
			: flat
			? undefined
			: { pane: pane.uid };
		if (!api.open({ tab: uid, to, ...(side ? { fit } : {}) })) return;
		setMeta((meta) => ({ ...meta, [uid]: content(choice, chat) }));
		requestAnimationFrame(() => focus(uid));
	}

	function swap(uid: string, choice: Choice) {
		if (choice === "chat") {
			close(uid);
			return activate(CHAT);
		}
		setMeta((meta) => ({ ...meta, [uid]: content(choice, chat) }));
		requestAnimationFrame(() => focus(uid));
	}

	function close(uid: string) {
		if (!api.close({ tab: uid })) return;
		const data = meta[uid];
		setMeta((meta) => {
			const next = { ...meta };
			delete next[uid];
			return next;
		});
		if (data) onTabClose?.(uid, data);
	}

	function rename(uid: string, name: string, restoreFocus = true) {
		if (uid === CHAT) return;
		const label = name.trim() || undefined;
		if (label && label.length > 80) throw new Error("Tab names must be 80 characters or fewer");
		setMeta((meta) => {
			const value = meta[uid] || fallback(uid);
			return value.name === label ? meta : { ...meta, [uid]: { ...value, name: label } };
		});
		if (restoreFocus) requestAnimationFrame(() => focus(uid));
	}

	function update(uid: string, patch: Partial<Content>) {
		setMeta((meta) => {
			const value = meta[uid];
			if (!value) return meta;
			return { ...meta, [uid]: { ...value, ...patch } as Content };
		});
	}

	return {
		api,
		meta,
		view,
		grips,
		grid,
		flat,
		desktop,
		resize,
		dnd,
		items,
		ghost,
		drag,
		nav,
		heads,
		frame,
		body,
		choose,
		allow,
		add,
		swap,
		close,
		rename,
		update,
	};
}

/** The original Ace tabbed layout: panes split on a grid, each with a strip of draggable tabs. */
export function Layout(props: Props) {
	const {
		api,
		meta,
		view,
		grips,
		grid,
		flat,
		desktop,
		resize,
		dnd,
		items,
		ghost,
		drag,
		nav,
		heads,
		frame,
		body,
		choose,
		allow,
		add,
		swap,
		close,
		rename,
		update,
	} = useLayout(props);

	function bar(pane: Split.Pane) {
		return {
			pane,
			actions: pane.uid === heads.at(-1)?.uid ? props.actions : undefined,
			items,
			flat,
			drag: ghost,
			drop: dnd.drop?.pane === pane.uid ? dnd.drop : undefined,
			onFork: (side: "right" | "bottom") => add(pane, "blank", side),
			can: (side: "right" | "bottom") => allow(pane, side),
			onSelect: (uid: string) => choose(uid, pane),
			onAdd: (choice: Choice) => add(pane, choice),
			onClose: close,
			onRename: rename,
			onStart: (event: PointerEvent<HTMLElement>, uid: string) => dnd.start(event, uid, pane.uid),
			onNav: nav,
		} satisfies BarProps;
	}

	return (
		<TooltipProvider>
			<div className="grid min-h-0 min-w-0 flex-1 overflow-hidden contain-style" style={frame}>
				<Header>
					<div className="col-[1/-1] grid h-full min-w-0 [grid-template-columns:subgrid] overflow-hidden contain-style">
						{heads.map((pane) => (
							<Bar
								key={pane.uid}
								{...bar(pane)}
								edge={pane.area[1][0] !== "CS"}
								line={false}
								start={pane.area[1][0] === "CS"}
								end={pane.area[1][1] === "CE"}
								style={{ gridColumn: column(pane), gridRow: "1" }}
							/>
						))}
					</div>
				</Header>
				<div ref={grid} className="relative grid min-h-0 bg-background contain-style" style={body}>
					{view.panes.map((pane) => (
						<Pane
							key={pane.uid}
							{...bar(pane)}
							meta={meta}
							focused={view.focus === pane.uid}
							header={top(pane)}
							render={props.render}
							onFocus={() => {
								if (!flat) api.focus({ pane: pane.uid });
							}}
							onChoose={swap}
							onUpdate={update}
						/>
					))}
					{desktop
						&& grips.map((handle) => (
							<Grip key={handle.uid} handle={handle} frozen={!!ghost} onStart={resize} />
						))}
				</div>
				{drag && ghost
					&& createPortal(<Ghost item={drag} drag={ghost} ref={dnd.preview} />, document.body)}
			</div>
		</TooltipProvider>
	);
}
