import {
	type ComponentPropsWithRef,
	createContext,
	type CSSProperties,
	type Dispatch,
	type PointerEvent,
	type ReactNode,
	type Ref,
	type SetStateAction,
	use,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { cn } from "../../lib/utils";
import { Divider } from "../divider";
import { LayoutBackground } from "./layout-background";
import { type Appearance, AppearanceProvider } from "../appearance";
import { useClickOutside } from "../../hooks/use-click-outside";
import { useMedia } from "../../hooks/use-media";
import { media } from "../../lib/screens";
import { useSuppressMotion } from "../../hooks/use-suppress-motion";

type ToggleContextValue = {
	open: boolean;
	collapsible?: boolean;
	setOpen: Dispatch<SetStateAction<boolean>>;
};

type LeftWidthContextValue = {
	/** Current left sidebar width in pixels (clamped to `[min, max]`). */
	width: number;
	/** Narrowest allowed width in pixels. */
	min: number;
	/** Widest allowed width in pixels. */
	max: number;
	/** Commit a new width; the value is clamped to `[min, max]`. */
	setWidth: (value: number) => void;
	/** Reset the width to its default. */
	reset: () => void;
	/** Signal the start of an interactive drag (disables the grid transition). */
	begin: () => void;
	/** Signal the end of an interactive drag. */
	end: () => void;
};

type LayoutContextValue = {
	nav: ToggleContextValue;
	left: ToggleContextValue;
	right: ToggleContextValue;
};

type LayoutState = {
	nav: "expanded" | "collapsed";
	left: "expanded" | "collapsed";
	right: "expanded" | "collapsed";
};

const NavContext = createContext<ToggleContextValue | null>(null);
const LeftContext = createContext<ToggleContextValue | null>(null);
const RightContext = createContext<ToggleContextValue | null>(null);
const LeftWidthContext = createContext<LeftWidthContextValue | null>(null);

/** Default width of the left sidebar in pixels (matches the CSS `--panel-left-width`). */
const DEFAULT_LEFT_WIDTH = 200;
/** Narrowest the left sidebar can be dragged, in pixels. */
const MIN_LEFT_WIDTH = 200;
/** Widest the left sidebar can be dragged, in pixels. */
const MAX_LEFT_WIDTH = 480;
const SLOT = [
	"[data-slot='dialog-content']",
	"[data-slot='dialog-overlay']",
	"[data-slot='dropdown-menu-content']",
	"[data-slot='context-menu-content']",
	"[data-slot='popover-content']",
	"[data-slot='sheet-content']",
	"[data-slot='sheet-overlay']",
	"[data-slot='tooltip-content']",
].join(",");

function setRef<T>(ref: Ref<T> | undefined, value: T) {
	if (typeof ref === "function") ref(value);
	else if (ref) (ref as { current: T }).current = value;
}

/** Access the nav panel's open state and toggle. */
function useLayoutNav() {
	let ctx = use(NavContext);
	if (!ctx) throw new Error("useLayoutNav must be used within Layout");
	return ctx;
}

/** Same as `useLayoutNav` but returns null instead of throwing when no Layout is present. */
function useLayoutNavOptional() {
	return use(NavContext);
}

/** Access the left sidebar's open state and toggle. */
function useLayoutLeft() {
	let ctx = use(LeftContext);
	if (!ctx) throw new Error("useLayoutLeft must be used within Layout");
	return ctx;
}

/** Access the right sidebar's open state and toggle. */
function useLayoutRight() {
	let ctx = use(RightContext);
	if (!ctx) throw new Error("useLayoutRight must be used within Layout");
	return ctx;
}

/** Access the left sidebar's resizable width. Returns null when no Layout is present. */
function useLayoutLeftWidth() {
	return use(LeftWidthContext);
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

/** Creates a toggle that's either controlled (external value + callback) or uncontrolled (internal useState). */
function useToggle(
	controlled: boolean | undefined,
	onChange: Dispatch<SetStateAction<boolean>> | undefined,
	fallback: boolean,
): ToggleContextValue {
	let [internal, setInternal] = useState(fallback);
	if (controlled !== undefined) {
		return { open: controlled, setOpen: onChange || setInternal };
	}
	return { open: internal, setOpen: setInternal };
}

type LayoutOptions = {
	defaultNavOpen: boolean;
	leftOpen?: boolean;
	onLeftChange?: Dispatch<SetStateAction<boolean>>;
	defaultLeftOpen: boolean;
	rightOpen?: boolean;
	onRightChange?: Dispatch<SetStateAction<boolean>>;
	defaultRightOpen: boolean;
};

function useLayoutValue(opts: LayoutOptions): LayoutContextValue {
	let sm = useMedia(media.sm);
	let md = useMedia(media.md);
	let lg = useMedia(media.lg);

	let [navOpen, setNavOpen] = useState(opts.defaultNavOpen);
	let nav = useMemo(
		() => ({ open: navOpen, setOpen: setNavOpen, collapsible: md }),
		[navOpen, md],
	);

	let leftDesktop = useToggle(opts.leftOpen, opts.onLeftChange, opts.defaultLeftOpen);
	let leftCompact = useToggle(undefined, undefined, false);
	let left = sm ? leftDesktop : leftCompact;

	let rightDesktop = useToggle(opts.rightOpen, opts.onRightChange, opts.defaultRightOpen);
	let rightCompact = useToggle(undefined, undefined, false);
	let right = lg ? rightDesktop : rightCompact;

	return { nav, left, right };
}

function getLayoutState(layout: LayoutContextValue): LayoutState {
	return {
		nav: layout.nav.open ? "expanded" : "collapsed",
		left: layout.left.open ? "expanded" : "collapsed",
		right: layout.right.open ? "expanded" : "collapsed",
	};
}

type Props = ComponentPropsWithRef<"div"> & {
	/** Visual appearance mode. Defaults to `"web"`. */
	appearance?: Appearance;
	/** Use static CSS dither instead of WebGPU canvas. */
	fallback?: boolean;
	/** Show the rounded-rect glow around the main panel to signal a loading state. */
	loading?: boolean;
	/** Multiplier for glow opacity. */
	glowOpacity?: number;
	/** Glow fade-in duration in seconds (0 = canvas default). */
	glowFadeIn?: number;
	/** Glow fade-out duration in seconds (0 = canvas default). */
	glowFadeOut?: number;

	/** Nav component. */
	nav?: ReactNode;
	/** Default nav open state. */
	defaultNavOpen?: boolean;

	/** Default left sidebar open state (uncontrolled). */
	defaultLeftOpen?: boolean;
	/** Controlled left sidebar open state. */
	leftOpen?: boolean;
	/** Callback when left sidebar open state changes. */
	onLeftChange?: Dispatch<SetStateAction<boolean>>;
	/** Controlled left sidebar width in pixels. */
	leftWidth?: number;
	/** Default left sidebar width in pixels (uncontrolled). */
	defaultLeftWidth?: number;
	/** Callback when the left sidebar width changes (drag committed). */
	onLeftWidthChange?: (value: number) => void;
	/** Narrowest the left sidebar can be dragged, in pixels. */
	minLeftWidth?: number;
	/** Widest the left sidebar can be dragged, in pixels. */
	maxLeftWidth?: number;

	/** Default right sidebar open state (uncontrolled). */
	defaultRightOpen?: boolean;
	/** Controlled right sidebar open state. */
	rightOpen?: boolean;
	/** Callback when right sidebar open state changes. */
	onRightChange?: Dispatch<SetStateAction<boolean>>;
};

/**
 * Application layout with CSS grid, dither canvas, and nav/sidebar state.
 * Children with `layout:left`, `layout:main`, `layout:right` classes snap into the grid.
 */
function Layout({
	className,
	children,
	ref,
	appearance = "web",
	fallback,
	loading,
	glowOpacity,
	glowFadeIn,
	glowFadeOut,
	style,
	nav,
	leftOpen,
	onLeftChange,
	leftWidth,
	onLeftWidthChange,
	defaultLeftWidth = DEFAULT_LEFT_WIDTH,
	minLeftWidth = MIN_LEFT_WIDTH,
	maxLeftWidth = MAX_LEFT_WIDTH,
	rightOpen,
	onRightChange,
	defaultNavOpen = true,
	defaultLeftOpen = true,
	defaultRightOpen = false,
	...props
}: Props) {
	let shell = useRef<HTMLDivElement>(null);
	let layout = useLayoutValue({
		defaultNavOpen,
		leftOpen,
		onLeftChange,
		defaultLeftOpen,
		rightOpen,
		onRightChange,
		defaultRightOpen,
	});
	let state = getLayoutState(layout);
	let sm = useMedia(media.sm);
	let lg = useMedia(media.lg);
	let leftCompact = !sm && layout.left.open;
	let rightCompact = !lg && layout.right.open;

	let [internalWidth, setInternalWidth] = useState(defaultLeftWidth);
	let [resizing, setResizing] = useState(false);
	let rawWidth = leftWidth ?? internalWidth;
	let width = clamp(rawWidth, minLeftWidth, maxLeftWidth);
	let leftWidthValue = useMemo<LeftWidthContextValue>(() => {
		function commit(value: number) {
			let next = clamp(Math.round(value), minLeftWidth, maxLeftWidth);
			if (leftWidth === undefined) setInternalWidth(next);
			onLeftWidthChange?.(next);
		}
		return {
			width,
			min: minLeftWidth,
			max: maxLeftWidth,
			setWidth: commit,
			reset: () => commit(defaultLeftWidth),
			begin: () => setResizing(true),
			end: () => setResizing(false),
		};
	}, [width, minLeftWidth, maxLeftWidth, defaultLeftWidth, leftWidth, onLeftWidthChange]);

	useSuppressMotion(shell);
	// A layout effect so the cleanup lifts inert from the main panel before a closing
	// sidebar's layout effect hands focus to its toggle there.
	useLayoutEffect(() => {
		if (!leftCompact && !rightCompact) return;

		let el = shell.current;
		if (!el) return;

		let items = Array.from(el.children).filter((item): item is HTMLElement =>
			item instanceof HTMLElement
		);
		let active = new Set(
			items.filter((item) => {
				if (leftCompact && item.classList.contains("layout:left")) return true;
				if (rightCompact && item.classList.contains("layout:right")) return true;
				return false;
			}),
		);

		if (!active.size) return;

		// An open sidebar owns its inert prop; restoring a stale value would override it on close.
		let prev = items.filter(item => !active.has(item)).map(item => [item, item.inert] as const);
		prev.forEach(([item]) => {
			item.inert = true;
		});

		return () => {
			prev.forEach(([item, inert]) => {
				item.inert = inert;
			});
		};
	}, [leftCompact, rightCompact]);

	return (
		<div
			ref={ref}
			data-appearance={appearance}
			data-nav={state.nav}
			data-left={state.left}
			data-right={state.right}
			data-loading={loading || undefined}
			// electrobun-webkit-app-region-drag: makes the shell a native window drag target in Electrobun
			className={cn(
				"overflow-hidden rounded-[inherit] squircle h-full electrobun-webkit-app-region-drag",
				className,
			)}
			style={style}
			{...props}
		>
			<LayoutBackground
				fallback={fallback}
				loading={loading}
				glowOpacity={glowOpacity}
				glowFadeIn={glowFadeIn}
				glowFadeOut={glowFadeOut}
			/>
			<div
				ref={shell}
				data-resizing={resizing || undefined}
				className="layout:shell p-2 relative h-full"
				style={{ "--panel-left-width": `${width}px` } as CSSProperties}
			>
				{appearance === "native" && (
					// Keep the top gutter outside panel no-drag regions, including the full-height sidebar.
					<div
						aria-hidden="true"
						className="absolute inset-x-0 top-0 z-30 h-2 electrobun-webkit-app-region-drag"
					/>
				)}
				<AppearanceProvider value={appearance}>
					<NavContext value={layout.nav}>
						<LeftContext value={layout.left}>
							<LeftWidthContext value={leftWidthValue}>
								<RightContext value={layout.right}>
									{nav}
									{children}
								</RightContext>
							</LeftWidthContext>
						</LeftContext>
					</NavContext>
				</AppearanceProvider>
			</div>
		</div>
	);
}

type SidebarProps = ComponentPropsWithRef<"div"> & {
	/** Which side of the layout this sidebar occupies. */
	side: "left" | "right";
	/** Class name for the inner wrapper that owns sidebar children. */
	innerClassName?: string;
};

/** Sidebar panel that snaps into the layout grid based on `side` prop. */
function Sidebar({ children, side, className, innerClassName, ref, ...props }: SidebarProps) {
	let node = useRef<HTMLDivElement>(null);
	let left = useLayoutLeft();
	let right = useLayoutRight();
	let sm = useMedia(media.sm);
	let lg = useMedia(media.lg);
	let item = side === "left" ? left : right;
	let compact = side === "left" ? !sm && left.open : !lg && right.open;

	useClickOutside(node, compact, () => item.setOpen(false), SLOT);

	// Runs before the browser drops focus from the newly inert subtree, so it can hand focus to
	// the visible control that toggles this sidebar instead of the document body.
	useLayoutEffect(() => {
		let el = node.current;
		if (item.open || !el?.contains(document.activeElement)) return;
		document.querySelector<HTMLElement>(`[aria-controls="${el.id}"]`)?.focus();
	}, [item.open]);

	return (
		<div
			ref={(el) => {
				node.current = el;
				setRef(ref, el);
			}}
			className={cn(
				side === "left" ? "layout:left" : "layout:right",
				"electrobun-webkit-app-region-no-drag",
				className,
			)}
			// The desktop left track collapses to zero width but stays visible, so hiding the closed
			// sidebar from focus and assistive technology can't rely on CSS visibility.
			aria-hidden={!item.open}
			inert={!item.open}
			{...props}
		>
			{side === "left" && <LeftDivider />}
			{side === "left" && <LeftResize />}
			<div
				className={cn(side === "left" ? "layout:left-inner" : "layout:right-inner", innerClassName)}
			>
				{children}
			</div>
		</div>
	);
}

function LeftDivider() {
	let left = useLayoutLeft();
	return (
		<Divider
			vertical
			className={cn(
				"absolute -inset-y-2 left-0 h-auto! hidden sm:block transition-opacity duration-250",
				!left.open && "opacity-0",
			)}
		/>
	);
}

/** Cursor to show while dragging the left resize grip, based on the clamp bounds. */
function resizeCursor(value: number, ctx: LeftWidthContextValue) {
	if (value <= ctx.min) return "east";
	if (value >= ctx.max) return "west";
	return "col";
}

/** Draggable grip on the right edge of the left sidebar that resizes its width. */
function LeftResize() {
	let left = useLayoutLeft();
	let width = useLayoutLeftWidth();
	let sm = useMedia(media.sm);
	let start = useRef<{ x: number; width: number } | null>(null);

	// The sidebar is a fixed grid column only on desktop; below `sm` it's an
	// overlay of fixed size, so dragging doesn't apply.
	if (!width || !sm) return null;

	function down(event: PointerEvent<HTMLButtonElement>) {
		if (!width || event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		start.current = { x: event.clientX, width: width.width };
		width.begin();
		document.documentElement.dataset.sessionResize = "col";
	}

	function move(event: PointerEvent<HTMLButtonElement>) {
		let origin = start.current;
		if (!origin || !width) return;
		let next = origin.width + (event.clientX - origin.x);
		width.setWidth(next);
		document.documentElement.dataset.sessionResize = resizeCursor(next, width);
	}

	function up(event: PointerEvent<HTMLButtonElement>) {
		if (!start.current || !width) return;
		start.current = null;
		width.end();
		delete document.documentElement.dataset.sessionResize;
		event.currentTarget.releasePointerCapture?.(event.pointerId);
	}

	return (
		<button
			type="button"
			aria-label="Resize sidebar"
			onPointerDown={down}
			onPointerMove={move}
			onPointerUp={up}
			onPointerCancel={up}
			onDoubleClick={() => width.reset()}
			// Hidden rather than unmounted when closed, so a focused grip is still inside the sidebar
			// when it hands focus to its toggle.
			className={cn(
				"group absolute inset-y-0 right-0 z-10 hidden w-3 cursor-col-resize touch-none select-none bg-transparent",
				left.open && "sm:block",
			)}
		>
			<span className="pointer-events-none absolute inset-y-0 right-0 w-px bg-primary opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
		</button>
	);
}

type MainProps = ComponentPropsWithRef<"main">;

/** Main content area that snaps into the layout grid. */
function Main({ className, ref, ...props }: MainProps) {
	return (
		<main
			ref={ref}
			className={cn(
				"layout:main utils:panel panel-inset relative flex flex-col electrobun-webkit-app-region-no-drag",
				className,
			)}
			{...props}
		/>
	);
}

export {
	Layout,
	Main,
	Sidebar,
	useLayoutLeft,
	useLayoutLeftWidth,
	useLayoutNav,
	useLayoutNavOptional,
	useLayoutRight,
};
