import {
	type ComponentPropsWithRef,
	type ReactNode,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal, flushSync } from "react-dom";

import * as scroll from "../../lib/scroll";
import { cn } from "../../lib/utils";

const EMPTY: scroll.Frame = { items: [], total: 0 };
const INTENT = 500;
const QUIET = 200;

/** Imperative handle exposed via ref. */
type ScrollViewHandle = {
	/** Scroll to the item at the given index. */
	scrollTo: (index: number) => void;
	/** The viewport element — useful for translating screen coordinates into canvas-relative ones. */
	viewport(): HTMLDivElement | null;
};

type ScrollViewRange = {
	start: number;
	end: number;
	pinned: boolean;
};

type ScrollViewHeight = (index: number, width: number) => number;
type ScrollViewRender = (index: number, width: number) => ReactNode;

type ScrollViewProps = Omit<ComponentPropsWithRef<"div">, "children" | "onScrollEnd" | "ref"> & {
	/** Total number of items. */
	count: number;
	/** Height getter — receives item index and viewport width. */
	height: ScrollViewHeight;
	/** Gap between items in pixels. */
	gap?: number;
	/** Additional scrollable space after the final item. */
	end?: number;
	/** Extra pixels to render above and below the viewport. */
	overscan?: number;
	/** Render callback — receives item index and viewport width. */
	children: ScrollViewRender;
	/** Called with the actually visible item range and bottom-pinned state. */
	onRangeChange?: (range: ScrollViewRange) => void;
	/** Called when native scrolling starts changing the viewport. */
	onScrollStart?: () => void;
	/** Called when native scrolling settles. */
	onScrollEnd?: () => void;
	ref?: React.Ref<ScrollViewHandle>;
};

/** Virtualized scroll container — imperative DOM positioning with React portals for content. */
function ScrollView(
	{
		count,
		height,
		gap = 0,
		end = 0,
		overscan = 300,
		children,
		onRangeChange,
		onScrollStart,
		onScrollEnd,
		className,
		ref,
		...props
	}: ScrollViewProps,
) {
	let viewport = useRef<HTMLDivElement>(null);
	let canvas = useRef<HTMLDivElement>(null);
	let cache = useRef(new Map<number, HTMLDivElement>());
	let range = useRef({ start: 0, end: 0 });
	let raf = useRef(0);
	let pin = useRef(true);
	let intent = useRef(Number.NEGATIVE_INFINITY);
	let pending = useRef<number | null>(null);
	let measured = useRef(0);
	let resized = useRef(false);
	let scrolling = useRef(false);
	let project = useRef<(flush: boolean) => void>(() => {});
	let report = useRef(onRangeChange);
	let started = useRef(onScrollStart);
	let settled = useRef(onScrollEnd);
	let reported = useRef<ScrollViewRange>({ start: -1, end: -1, pinned: false });
	let [visible, setVisible] = useState({ start: 0, end: 0 });
	let [width, setWidth] = useState(0);
	// Wait for a measured viewport width before building the frame, otherwise width=0 can
	// inflate the initial visible range and trigger a very expensive first render.
	let ready = width > 0;

	let heightAt = useMemo(() => (i: number) => height(i, width), [height, width]);
	let frame = useMemo(() => ready ? scroll.frame(count, heightAt, gap, end) : EMPTY, [
		count,
		end,
		gap,
		heightAt,
		ready,
	]);
	let prevFrame = useRef(frame);
	let frameRef = useRef(frame);

	function notify(range: ScrollViewRange) {
		let prev = reported.current;
		if (prev.start === range.start && prev.end === range.end && prev.pinned === range.pinned) {
			return;
		}
		reported.current = range;
		report.current?.(range);
	}

	let jump = (index: number, flush: boolean) => {
		let el = viewport.current;
		let item = frameRef.current.items[index];
		if (!el || !item) return false;

		pin.current = false;
		el.scrollTop = Math.max(0, item.top - Math.max(0, (el.clientHeight - item.height) / 2));
		project.current(flush);
		return true;
	};

	useImperativeHandle(ref, () => ({
		scrollTo(index: number) {
			if (jump(index, true)) return;
			if (!ready || !viewport.current) pending.current = index;
		},
		viewport() {
			return viewport.current;
		},
	}));

	useLayoutEffect(() => {
		frameRef.current = frame;
		report.current = onRangeChange;
		started.current = onScrollStart;
		settled.current = onScrollEnd;
		project.current = (flush) => {
			let el = viewport.current;
			let cvs = canvas.current;
			if (!el || !cvs) return;
			if (!ready) return;

			let f = frameRef.current;
			if (resized.current && pin.current) {
				el.scrollTop = Math.max(0, f.total - el.clientHeight);
			}
			resized.current = false;

			let bottom = f.total - el.scrollTop - el.clientHeight < 1;
			let manual = performance.now() - intent.current < INTENT;
			if (bottom || manual) {
				pin.current = bottom;
			} else if (pin.current) {
				el.scrollTop = Math.max(0, f.total - el.clientHeight);
				bottom = true;
			}

			let { start, end } = scroll.visible(f, el.scrollTop, el.clientHeight, overscan);
			let prev = range.current;
			let overlapStart = Math.max(start, prev.start);
			let overlapEnd = Math.min(end, prev.end);

			for (let i = prev.start; i < Math.min(prev.end, start); i++) {
				let node = cache.current.get(i);
				if (node) {
					node.remove();
					cache.current.delete(i);
				}
			}
			for (let i = Math.max(prev.start, end); i < prev.end; i++) {
				let node = cache.current.get(i);
				if (node) {
					node.remove();
					cache.current.delete(i);
				}
			}

			let place = (i: number): HTMLDivElement | null => {
				let item = f.items[i];
				if (!item) return null;
				let node = cache.current.get(i);
				if (!node) {
					node = document.createElement("div");
					cache.current.set(i, node);
				}
				node.style.cssText =
					`position:absolute;top:${item.top}px;height:${item.height}px;contain:size style;content-visibility:auto;inset-inline:0;`;
				return node;
			};

			if (overlapStart >= overlapEnd) {
				for (let i = start; i < end; i++) {
					let node = place(i);
					if (node && !node.parentNode) cvs.appendChild(node);
				}
			} else {
				let anchor = cache.current.get(overlapStart) || null;
				for (let i = overlapStart - 1; i >= start; i--) {
					let node = place(i);
					if (!node) continue;
					if (anchor) {
						if (node.parentNode !== cvs || node.nextSibling !== anchor) {
							cvs.insertBefore(node, anchor);
						}
					} else if (!node.parentNode) {
						cvs.appendChild(node);
					}
					anchor = node;
				}
				for (let i = overlapStart; i < overlapEnd; i++) place(i);
				for (let i = overlapEnd; i < end; i++) {
					let node = place(i);
					if (node && !node.parentNode) cvs.appendChild(node);
				}
			}

			if (prev.start !== start || prev.end !== end) {
				range.current = { start, end };
				let update = () => setVisible({ start, end });
				if (flush) flushSync(update);
				else update();
			}

			let exact = scroll.visible(f, el.scrollTop, el.clientHeight);
			notify({ ...exact, pinned: bottom });
		};
	});

	useEffect(() => {
		let el = viewport.current;
		if (!el) return;
		let active = true;

		let schedule = () => {
			if (raf.current) return;
			raf.current = requestAnimationFrame(() => {
				raf.current = 0;
				project.current(true);
			});
		};
		// Browsers send no scrollend when they clamp scrollTop after content shrinks, so a
		// quiet period also ends a scroll; otherwise onScrollEnd never runs.
		let quiet: ReturnType<typeof setTimeout> | undefined;
		let onscroll = () => {
			if (!scrolling.current) {
				scrolling.current = true;
				started.current?.();
			}
			clearTimeout(quiet);
			quiet = setTimeout(done, QUIET);
			schedule();
		};
		let done = () => {
			clearTimeout(quiet);
			if (!scrolling.current) return;
			scrolling.current = false;
			settled.current?.();
		};
		let mark = () => {
			intent.current = performance.now();
		};

		let observer = new ResizeObserver((entries) => {
			let entry = entries[0];
			if (!entry) return;
			let next = Math.round(entry.contentRect.width);
			resized.current = true;
			if (next === measured.current) {
				schedule();
				return;
			}
			measured.current = next;
			// Commit synchronously so the frame (which is width-derived) stays in
			// sync with the live container width. Deferring through React's async
			// scheduler lets the browser paint a frame where container CSS width
			// is already new but item node.style.height is still from the old
			// frame, which clips content due to `contain: size`.
			flushSync(() => setWidth(next));
			schedule();
		});
		observer.observe(el);
		el.addEventListener("scroll", onscroll, { passive: true });
		el.addEventListener("scrollend", done, { passive: true });
		el.addEventListener("wheel", mark, { passive: true });
		el.addEventListener("touchstart", mark, { passive: true });
		el.addEventListener("touchmove", mark, { passive: true });
		el.addEventListener("pointerdown", mark, { passive: true });
		el.addEventListener("keydown", mark);
		schedule();

		document.fonts.ready.then(() => {
			if (active) schedule();
		});

		return () => {
			active = false;
			clearTimeout(quiet);
			observer.disconnect();
			el.removeEventListener("scroll", onscroll);
			el.removeEventListener("scrollend", done);
			el.removeEventListener("wheel", mark);
			el.removeEventListener("touchstart", mark);
			el.removeEventListener("touchmove", mark);
			el.removeEventListener("pointerdown", mark);
			el.removeEventListener("keydown", mark);
			cancelAnimationFrame(raf.current);
			raf.current = 0;
			scrolling.current = false;
			for (let [, node] of cache.current) node.remove();
			cache.current.clear();
			range.current = { start: 0, end: 0 };
		};
	}, []);

	useLayoutEffect(() => {
		let el = viewport.current;
		if (!el || !ready) return;

		let prev = prevFrame.current;
		prevFrame.current = frame;

		let target = pending.current;
		if (target !== null && jump(target, false)) {
			pending.current = null;
		} else if (pin.current) {
			el.scrollTop = Math.max(0, frame.total - el.clientHeight);
		} else if (prev !== frame && prev.items.length > 0) {
			let { start } = scroll.visible(prev, el.scrollTop, el.clientHeight);
			let prevItem = prev.items[start];
			let nextItem = frame.items[start];
			if (prevItem && nextItem) {
				let offset = el.scrollTop - prevItem.top;
				let max = Math.max(0, frame.total - el.clientHeight);
				el.scrollTop = Math.max(0, Math.min(max, nextItem.top + offset));
			}
		}

		project.current(false);
	}, [frame, ready]);

	return (
		<div
			ref={viewport}
			data-slot="scroll-view"
			className={cn("relative overflow-auto", className)}
			{...props}
		>
			<div ref={canvas} className="relative" style={{ height: frame.total }} />
			{Array.from({ length: visible.end - visible.start }, (_, i) => {
				let idx = visible.start + i;
				if (!frame.items[idx]) return null;
				let container = cache.current.get(idx);
				if (!container) return null;
				return createPortal(children(idx, width), container, String(idx));
			})}
		</div>
	);
}

export { ScrollView };
export type {
	ScrollViewHandle,
	ScrollViewHeight,
	ScrollViewProps,
	ScrollViewRange,
	ScrollViewRender,
};
