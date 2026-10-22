import { type MouseEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { FileTreeRowDecorationContext } from "@pierre/trees";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";

import { cn } from "../../lib/utils";

type Decoration = {
	text: string;
	title?: string;
};

type FileTreeProps = {
	/** Flat list of file paths to render as a tree. */
	paths: string[];
	/** Selected path; its row is selected and scrolled into view. */
	selected?: string;
	/** Initial expansion: every folder (`all`) or only the ancestors of `selected`. */
	expand?: "all" | "ancestors";
	/** Optional trailing decoration per path (e.g. diff `+N -M` counts). */
	decorations?: Map<string, Decoration>;
	/** Activated by a normal click or keyboard selection. */
	onSelect?: (path: string) => void;
	/** Activated by cmd/ctrl-click. When set, such clicks fire this without moving the selection. */
	onOpenTab?: (path: string) => void;
	className?: string;
};

type Click = {
	tab?: boolean;
	path?: string;
};

const THEME = `
	:host {
		--trees-bg-override: transparent;
		--trees-fg-override: var(--color-foreground);
		--trees-fg-muted-override: var(--color-muted-foreground);
		--trees-border-color-override: var(--color-border);
		--trees-selected-bg-override: var(--color-muted);
		--trees-padding-inline-override: 8px;
	}

	/* Full-width 32px search header (matches the file headers), with an inset
	   divider so the line adds no layout height. */
	[data-file-tree-search-container] {
		height: 32px;
		padding-inline: 0;
		margin-bottom: 0;
		box-shadow: inset 0 -1px var(--trees-border-color);
	}

	[data-file-tree-search-input] {
		box-sizing: border-box;
		height: 100%;
		margin-block: 0;
		padding-block: 0;
		padding-inline: 12px;
		border: 0;
		border-radius: 0;
		background-color: transparent;
	}
`;

function parents(path: string) {
	let parts = path.split("/").filter(Boolean).slice(0, -1);
	let paths: string[] = [];
	let next = "";
	for (let part of parts) {
		next = next ? `${next}/${part}` : part;
		paths.push(next);
	}
	return paths;
}

function clicked(event: MouseEvent<HTMLElement>) {
	for (let item of event.nativeEvent.composedPath()) {
		if (!(item instanceof HTMLElement)) continue;
		let path = item.dataset.itemPath ?? item.dataset.fileTreeStickyPath;
		if (path) return path;
	}
}

function Tree({
	paths,
	selected = "",
	expand = "ancestors",
	decorations,
	onSelect,
	onOpenTab,
	className,
}: FileTreeProps) {
	let lookup = useMemo(() => new Set(paths), [paths]);
	let pathRef = useRef(selected);
	let lookupRef = useRef(lookup);
	let selectRef = useRef(onSelect);
	let tabRef = useRef(onOpenTab);
	let decoRef = useRef(decorations);
	let option = useRef<Click | undefined>(undefined);
	let selecting = useRef(false);
	useLayoutEffect(() => {
		pathRef.current = selected;
		lookupRef.current = lookup;
		selectRef.current = onSelect;
		tabRef.current = onOpenTab;
		decoRef.current = decorations;
	}, [selected, lookup, onSelect, onOpenTab, decorations]);

	let { model } = useFileTree({
		density: "compact",
		flattenEmptyDirectories: true,
		icons: { colored: true, set: "standard" },
		search: true,
		paths,
		initialSelectedPaths: selected ? [selected] : undefined,
		...(expand === "all"
			? { initialExpansion: "open" as const }
			: { initialExpandedPaths: parents(selected) }),
		...(decorations
			? {
				renderRowDecoration: (context: FileTreeRowDecorationContext) =>
					decoRef.current?.get(context.item.path) ?? null,
			}
			: undefined),
		unsafeCSS: THEME,
		onSelectionChange(picked) {
			if (selecting.current) return;
			let files = lookupRef.current;
			let current = pathRef.current;
			let aimed = option.current?.path;
			let file = aimed && files.has(aimed) ? aimed : picked.findLast(item => files.has(item));
			if (!file || file === current) return;
			let open = option.current?.tab ? tabRef.current : undefined;
			if (!open) {
				selectRef.current?.(file);
				return;
			}
			open(file);
			// A tab-open must not move the visible selection; restore it.
			queueMicrotask(() => {
				let item = model.getItem(current);
				if (!item) return;
				selecting.current = true;
				item.select();
				queueMicrotask(() => {
					selecting.current = false;
				});
			});
		},
	});

	function click(event: MouseEvent<HTMLElement>) {
		let path = clicked(event);
		let tab = event.metaKey || event.ctrlKey;
		option.current = tab || path
			? {
				...(tab ? { tab: true } : undefined),
				...(path ? { path } : undefined),
			}
			: undefined;
		setTimeout(() => {
			option.current = undefined;
		}, 0);
		// Clicking the selected file changes no selection, so onSelectionChange
		// stays silent; select it again so callers can scroll back to it.
		if (!tab && path && path === pathRef.current && lookupRef.current.has(path)) {
			selectRef.current?.(path);
		}
	}

	let sync = useCallback((file: string) => {
		for (let parent of parents(file)) {
			let item = model.getItem(parent);
			if (item && "expand" in item) item.expand();
		}
		let item = model.getItem(file);
		if (!item) return;
		// Selection is exclusive: deselect stragglers (item.select() is additive),
		// then select and reveal the target. Guarded so it doesn't echo onSelect.
		selecting.current = true;
		for (let path of model.getSelectedPaths()) {
			if (path !== file) model.getItem(path)?.deselect();
		}
		if (!item.isSelected()) item.select();
		model.scrollToPath(file, { focus: false, offset: "nearest" });
		queueMicrotask(() => {
			selecting.current = false;
		});
	}, [model]);

	useEffect(() => {
		if (selected) sync(selected);
	}, [selected, sync]);

	if (!paths.length) {
		return <div className="px-3 py-2 text-sm text-muted-foreground">No files</div>;
	}

	return (
		<PierreFileTree
			model={model}
			className={cn("block h-full min-h-0", className)}
			onClickCapture={click}
		/>
	);
}

/** Virtualized file tree wrapping `@pierre/trees`, shared by the browse and diff panels.
 *  The model is built once per path set, so the inner view is keyed by the paths. */
function FileTree(props: FileTreeProps) {
	let key = useMemo(() => props.paths.join("\0"), [props.paths]);
	return <Tree key={key} {...props} />;
}

export { FileTree };
export type { FileTreeProps };
