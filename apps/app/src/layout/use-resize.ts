import {
	type KeyboardEvent as KeyEvent,
	type PointerEvent,
	useCallback,
	useEffect,
	useEffectEvent,
	useRef,
	useState,
} from "react";

import * as Split from "@ace/split-tabs";
import { media, useMedia } from "@ace/ui";

type Box = {
	width: number;
	height: number;
};

type Cursor = "col" | "row" | "east" | "west" | "south" | "north" | "none";

type Resize = {
	axis: Split.Axis;
	line: string;
	pointer: number;
	start: number;
	ratio: number;
	value: number;
	size: number;
	state: Split.State;
	limit: Split.Bounds;
	cursor?: Cursor;
	min?: Split.Min;
};

const EPS = 0.000001;

function value(state: Split.State, item: Resize) {
	const list = item.axis === "col" ? state.cols : state.rows;
	return list.find(line => line.uid === item.line)?.ratio ?? item.ratio;
}

function cursor(item: Resize): Cursor {
	if (item.limit.max - item.limit.min < EPS) return "none";
	if (item.value <= item.limit.min + EPS) return item.axis === "col" ? "east" : "south";
	if (item.value >= item.limit.max - EPS) return item.axis === "col" ? "west" : "north";
	return item.axis;
}

function paint(item: Resize) {
	const next = cursor(item);
	if (item.cursor === next) return;

	item.cursor = next;
	document.documentElement.dataset.layoutResize = next;
}

function clear() {
	delete document.documentElement.dataset.layoutResize;
}

export function useResize(
	api: Split.Api,
	state: Split.State,
	min?: Split.Min,
) {
	const grid = useRef<HTMLDivElement | null>(null);
	const resize = useRef<Resize | undefined>(undefined);
	const [node, setNode] = useState<HTMLDivElement | null>(null);
	const [box, setBox] = useState<Box>({ width: 0, height: 0 });
	const desktop = useMedia(media.md);
	const fit = box.width === 0 || box.height === 0
		|| Split.fits(state, { width: box.width, height: box.height, min });
	const flat = !desktop || !fit;
	const view = Split.view(state, { width: box.width, height: box.height, min, flat });
	const grips = flat ? [] : Split.handles(view);
	const css = Split.style(view);

	const ref = useCallback((node: HTMLDivElement | null) => {
		grid.current = node;
		setNode(node);
	}, []);

	function apply(state: Split.State, axis?: Split.Axis) {
		const node = grid.current;
		if (!node) return;

		const css = Split.style(state);
		if (axis !== "row") {
			const frame = node.parentElement;
			if (frame) frame.style.gridTemplateColumns = css.gridTemplateColumns;
		}
		if (axis !== "col") node.style.gridTemplateRows = css.gridTemplateRows;
	}

	function stretch(id: number, x: number, y: number) {
		const item = resize.current;
		if (!item || item.pointer !== id) return false;

		const ratio = item.ratio + ((item.axis === "col" ? x : y) - item.start) / item.size;
		const next = Split.resize(item.state, {
			axis: item.axis,
			line: item.line,
			ratio,
			size: item.size,
			min: item.min,
		});
		item.value = value(next, item);
		apply(next, item.axis);
		paint(item);
		return true;
	}

	function stop(id?: number, commit = false, reset = true) {
		const item = resize.current;
		if (id !== undefined && item?.pointer !== id) return false;

		resize.current = undefined;
		if (!item) return false;
		clear();

		if (commit) {
			api.resize({
				axis: item.axis,
				line: item.line,
				ratio: item.value,
				size: item.size,
			});
		} else if (reset) apply(item.state, item.axis);

		return !!item;
	}

	useEffect(() => {
		if (!node) return;

		const observer = new ResizeObserver(([entry]) => {
			const { height, width } = entry.contentRect;
			setBox(prev => prev.width === width && prev.height === height ? prev : { width, height });
		});
		observer.observe(node);
		return () => {
			observer.disconnect();
		};
	}, [node]);

	const end = useEffectEvent(stop);

	useEffect(() => {
		const scope = new AbortController();
		const capture = { capture: true, signal: scope.signal };
		const options = { signal: scope.signal };

		function move(event: globalThis.PointerEvent) {
			if (stretch(event.pointerId, event.clientX, event.clientY)) event.preventDefault();
		}

		function up(event: globalThis.PointerEvent) {
			if (end(event.pointerId, true)) event.preventDefault();
		}

		function cancel(event: globalThis.PointerEvent) {
			if (end(event.pointerId)) event.preventDefault();
		}

		function blur() {
			end();
		}

		function key(event: KeyboardEvent) {
			if (event.key === "Escape" && end()) event.preventDefault();
		}

		function visible() {
			if (document.visibilityState !== "visible") end();
		}

		document.addEventListener("pointermove", move, capture);
		document.addEventListener("pointerup", up, capture);
		document.addEventListener("pointercancel", cancel, capture);
		document.addEventListener("keydown", key, options);
		document.addEventListener("visibilitychange", visible, options);
		window.addEventListener("blur", blur, options);

		return () => {
			scope.abort();
			clear();
		};
	}, []);

	useEffect(() => {
		if (!flat) return;
		resize.current = undefined;
		clear();
	}, [flat]);

	function measure(handle: Split.Handle) {
		const rect = grid.current?.getBoundingClientRect();
		if (!rect) return;

		const size = handle.axis === "col" ? rect.width : rect.height;
		if (size <= 0) return;

		const limit = Split.bounds(view, {
			axis: handle.axis,
			line: handle.line,
			ratio: handle.ratio,
			size,
			min,
		});
		if (limit) return { size, limit };
	}

	function start(event: PointerEvent<HTMLElement>, handle: Split.Handle) {
		const box = measure(handle);
		if (!box) return;

		const { size, limit } = box;
		const base = view;

		const item: Resize = {
			axis: handle.axis,
			line: handle.line,
			pointer: event.pointerId,
			start: handle.axis === "col" ? event.clientX : event.clientY,
			ratio: handle.ratio,
			value: handle.ratio,
			size,
			state: base,
			limit,
			min,
		};
		resize.current = item;
		paint(item);
		event.preventDefault();
		event.stopPropagation();
	}

	// Arrows move a divider 16px (64px with Shift); Home and End go to its limits, like a window splitter.
	function key(event: KeyEvent<HTMLElement>, handle: Split.Handle) {
		const back = handle.axis === "col" ? "ArrowLeft" : "ArrowUp";
		const ahead = handle.axis === "col" ? "ArrowRight" : "ArrowDown";
		if (![back, ahead, "Home", "End"].includes(event.key)) return;

		const box = measure(handle);
		if (!box) return;

		event.preventDefault();
		const step = (event.shiftKey ? 64 : 16) / box.size;
		const ratio = event.key === "Home"
			? box.limit.min
			: event.key === "End"
			? box.limit.max
			: handle.ratio + (event.key === ahead ? step : -step);
		api.resize({ axis: handle.axis, line: handle.line, ratio, size: box.size });
	}

	return {
		view,
		css,
		grips,
		grid: ref,
		flat,
		desktop,
		box,
		start,
		key,
	};
}
