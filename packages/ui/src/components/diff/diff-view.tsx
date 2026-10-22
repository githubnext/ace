import {
	useCallback,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CodeView } from "@pierre/diffs/react";
import type { CodeViewItem, CodeViewOptions } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

import { cn } from "../../lib/utils";
import { diffOptions, parseDiff } from "../../lib/highlighter";
import { Button } from "../../ui/button";
import { TooltipProvider } from "../../ui/tooltip";

import { FileTree } from "../file-tree/file-tree";
import { GitActionButton } from "../git-action";
import { PrAction, ToolButton } from "./diff-actions";
import { FileTreeShell } from "./diff-file-tree";
import { same, selection } from "./selection";
import type { DiffViewFile, DiffViewMode, DiffViewPr, DiffViewProps } from "./types";
import type { Selection } from "./selection";
import {
	IconChevronRight,
	IconCollapseVertical,
	IconExpandVertical,
	IconFileDiff,
	IconListTree,
	IconLoader,
	IconRows,
	IconSplitView,
} from "../../icons";

type Totals = {
	group?: string;
	adds: number;
	dels: number;
	files: number;
	/** Binary files and summarized directories, which have no line counts. */
	fixed: boolean;
};

type Cache = {
	item: CodeViewItem;
	key: string;
};

type HeaderProps = {
	active: boolean;
	file: DiffViewFile;
	open: boolean;
	subtitle?: string;
	/** Shown when the file is listed in more than one group, so its headers differ. */
	group?: string;
	onToggle: (file: DiffViewFile, open: boolean) => void;
};

const HEADER = 32;
const BUFFER = 1600;

/** One total per group, in the order groups first appear, so groups' counts never merge. */
function total(files: DiffViewFile[]): Totals[] {
	let groups = new Map<string | undefined, Totals>();
	for (let file of files) {
		let sum = groups.get(file.group);
		if (!sum) {
			groups.set(file.group, sum = { group: file.group, adds: 0, dels: 0, files: 0, fixed: false });
		}
		sum.adds += file.adds;
		sum.dels += file.dels;
		sum.files += file.count ?? 1;
		sum.fixed ||= fixed(file);
	}
	return [...groups.values()];
}

/** Grouped files can repeat a path, so their identity, and tree path, includes the group. */
function id(file: DiffViewFile) {
	return file.group ? `${file.group}/${file.file}` : file.file;
}

function fixed(file: DiffViewFile) {
	return file.binary || !!file.note;
}

function basename(path: string) {
	let index = path.lastIndexOf("/");
	return index === -1 ? path : path.slice(index + 1);
}

function dirname(path: string) {
	let index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

function filesKey(files: DiffViewFile[]) {
	return files.map(file => `${file.from ?? ""}->${id(file)}`).join("\0");
}

function stamp(file: DiffViewFile) {
	return [
		file.signature ?? (file.patch === undefined ? "missing" : `inline:${file.patch.length}`),
		file.adds,
		file.dels,
		file.binary ? "binary" : "text",
		file.pending ? "pending" : "ready",
		file.error ?? "",
	].join("\0");
}

function plural(count: number, one: string, many: string) {
	return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** Paths listed in more than one group, such as a file both committed and edited since. */
function regrouped(files: DiffViewFile[]) {
	let seen = new Set<string>();
	let repeated = new Set<string>();
	for (let file of files) {
		if (seen.has(file.file)) repeated.add(file.file);
		seen.add(file.file);
	}
	return repeated;
}

function duplicateNames(files: DiffViewFile[]) {
	let counts = new Map<string, number>();
	for (let file of files) {
		let name = basename(file.file);
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

function context(file: DiffViewFile, duplicates: Set<string>) {
	if (file.from) return `${file.from} -> ${file.file}`;
	if (duplicates.has(basename(file.file))) return dirname(file.file);
}

function hash(value: string) {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function text(file: DiffViewFile) {
	if (file.pending) return `Loading diff for ${file.file}...`;
	if (file.error) return file.error;
	if (file.patch === undefined) return `Diff not loaded for ${file.file}.`;
	return "Invalid or empty patch.";
}

function option(view: DiffViewMode): CodeViewOptions<undefined> {
	let base = diffOptions(view);
	return {
		diffIndicators: base.diffIndicators,
		diffStyle: view,
		disableFileHeader: false,
		expansionLineCount: base.expansionLineCount,
		hunkSeparators: "line-info",
		itemMetrics: {
			diffHeaderHeight: HEADER,
			hunkLineCount: 8,
			lineHeight: 20,
			paddingBottom: 0,
			paddingTop: 0,
			spacing: 0,
		},
		layout: {
			gap: 0,
			paddingBottom: 0,
			paddingTop: 0,
		},
		overflow: "scroll",
		stickyHeaders: true,
		theme: base.theme,
		unsafeCSS: `
			${base.unsafeCSS ?? ""}

			:host {
				--diffs-light-bg: transparent;
				--diffs-dark-bg: transparent;
				--diffs-header-font-family: var(--font-sans);
				--diffs-font-family: var(--font-mono);
				--diffs-font-size: 12px;
				--diffs-line-height: 20px;
				--diffs-gap-fallback: 0px;
				--diffs-bg-buffer-override: transparent;
				--diffs-bg-separator-override: var(--color-background);
				--diffs-bg-context-override: color-mix(in oklch, var(--color-code), transparent 18%);
				--diffs-bg-context-gutter-override: color-mix(in oklch, var(--color-code), transparent 8%);
				--diffs-bg-addition-override: color-mix(in oklch, var(--color-accent), transparent 82%);
				--diffs-bg-deletion-override: color-mix(in oklch, var(--color-destructive), transparent 84%);
				--diffs-addition-color-override: var(--color-accent);
				--diffs-deletion-color-override: var(--color-destructive);
			}

			[data-code] {
				padding-block-start: 0;
				padding-block-end: 0;
			}

			[data-diffs-header] {
				block-size: ${HEADER}px;
				min-block-size: ${HEADER}px;
				max-block-size: ${HEADER}px;
				padding-inline: 0;
				overflow: hidden;
				border-block-end: 0;
				box-shadow: inset 0 -1px var(--color-border);
			}

			slot[name='header-custom']::slotted(*) {
				block-size: 100%;
				inline-size: 100%;
			}

			[data-diffs-header][data-sticky] {
				background-color: color-mix(in oklch, var(--color-popover), transparent 4%);
			}
		`,
	};
}

function item(file: DiffViewFile, open: boolean, cache: Map<string, Cache>): CodeViewItem {
	let state = `${stamp(file)}\0${open ? "open" : "closed"}`;
	let version = hash(state);
	let key = `${id(file)}\0${version}`;
	let cached = cache.get(id(file));
	if (cached?.key === key) return cached.item;

	let { patch } = file;
	let parsed = fixed(file) || patch === undefined ? null : parseDiff(
		patch,
		file.oldFile && file.newFile ? { oldFile: file.oldFile, newFile: file.newFile } : undefined,
	);
	// Stamp a content-stable cacheKey so pierre's worker cache survives a
	// scroll-release/re-create instead of re-highlighting (a visible flash).
	if (parsed && !parsed.cacheKey) {
		parsed.cacheKey = file.signature || `${id(file)}\0${patch?.length}`;
	}
	let next: CodeViewItem = parsed
		? {
			id: id(file),
			type: "diff",
			fileDiff: parsed,
			version,
			collapsed: !open,
		}
		: {
			id: id(file),
			type: "file",
			file: {
				name: file.file,
				contents: text(file),
				lang: "text",
				cacheKey: key,
			},
			version,
			collapsed: !open,
		};

	cache.set(id(file), { key, item: next });
	return next;
}

function Header({
	active,
	file,
	open,
	subtitle,
	group,
	onToggle,
}: HeaderProps) {
	let name = basename(file.file);
	let from = file.from ? basename(file.from) : undefined;
	let dir = !from && subtitle ? dirname(file.file) : undefined;
	return (
		<div
			className={cn(
				"grid h-full grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 bg-popover/55 py-0 pr-1.5 pl-3 text-foreground transition-[background-color] duration-150 ease-out motion-reduce:transition-none",
				active && "bg-background",
			)}
		>
			<button
				type="button"
				className="min-w-0 rounded-md text-left transition-[color] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-ring/50 focus-visible:outline-none motion-reduce:transition-none"
				aria-expanded={fixed(file) ? undefined : open}
				title={group ? `${subtitle ?? file.file} (${group})` : subtitle ?? file.file}
				onClick={() => onToggle(file, open)}
			>
				<span className="flex min-w-0 items-baseline gap-3 text-xs font-medium">
					<span className="min-w-0 truncate">
						{from
							? (
								<>
									<span className="text-muted-foreground">{from} →</span>
									{" "}
								</>
							)
							: null}
						{name}
						{dir
							? (
								<>
									{" "}
									<span className="text-muted-foreground">{dir}</span>
								</>
							)
							: null}
					</span>
					{group ? <span className="shrink-0 text-muted-foreground">{group}</span> : null}
					{fixed(file)
						? <span className="shrink-0 text-muted-foreground">{file.note || "Binary"}</span>
						: (
							<span className="flex shrink-0 items-center gap-1 tabular-nums">
								<span className="text-accent">+{file.adds}</span>
								<span className="text-destructive">-{file.dels}</span>
							</span>
						)}
					{file.pending
						? (
							<IconLoader
								className="size-3.5 shrink-0 animate-spin text-muted-foreground"
								aria-hidden
							/>
						)
						: null}
				</span>
			</button>
			{fixed(file)
				? null
				: (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="size-5.5 aria-expanded:bg-transparent aria-expanded:hover:bg-muted dark:aria-expanded:hover:bg-muted/50"
						aria-label={open ? `Collapse ${file.file}` : `Expand ${file.file}`}
						aria-expanded={open}
						onClick={() => onToggle(file, open)}
					>
						<IconChevronRight
							className={cn(
								"size-3 transition-transform duration-150 ease-in-out motion-reduce:transition-none",
								open && "rotate-90",
							)}
							aria-hidden
						/>
					</Button>
				)}
		</div>
	);
}

type Kept = {
	tree: [boolean, (update: (open: boolean) => boolean) => void];
	mode: [DiffViewMode, (mode: DiffViewMode) => void];
};

/** The content remounts when the file list changes, so view choices live out here. */
function DiffView(props: DiffViewProps) {
	let key = useMemo(() => filesKey(props.files), [props.files]);
	let tree = useState(props.defaultFileTreeOpen ?? false);
	let mode = useState<DiffViewMode>(props.defaultMode ?? "unified");
	return <DiffViewContent key={key} {...props} kept={{ tree, mode }} />;
}

function useDiffView({
	kept,
	files,
	base = "origin/main",
	head = "Changes",
	pr,
	creatingPr,
	preparingPr,
	mode,
	selected,
	selectedKey,
	onSelectedChange,
	onModeChange,
	onOpenPr,
	onCreatePr,
	onCreateDraftPr,
	onManualCreatePr,
	actions,
	onFileOpen,
	className,
}: DiffViewProps & { kept: Kept }) {
	let [navigation, setNavigation] = useState<
		{ current: string; applied?: Selection; pending?: string; request?: Selection }
	>(() => ({ current: files[0]?.file ?? "" }));
	let { current } = navigation;
	let [internalMode, setInternalMode] = kept.mode;
	let [treeOpen, setTreeOpen] = kept.tree;
	let [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
	let code = useRef<CodeViewHandle<undefined>>(null);
	let cache = useRef(new Map<string, Cache>());

	let names = useMemo(() => new Set(files.map(file => id(file))), [files]);
	let external = useMemo(() => selection(names, selected, selectedKey), [
		names,
		selected,
		selectedKey,
	]);
	// A selectedKey is a navigation intent, including re-opening an already selected file.
	// Preserve user collapse actions when the parent acknowledges their selection.
	if (!same(navigation.applied, external)) {
		let request = external && !(navigation.pending === external.file && external.key === undefined)
			? external
			: undefined;
		setNavigation({ current: external?.file ?? current, applied: external, request });
		if (request) {
			setCollapsed(previous => {
				if (!previous.has(request.file)) return previous;
				let next = new Set(previous);
				next.delete(request.file);
				return next;
			});
		}
	}
	let active = external
		? external.file
		: names.has(current)
		? current
		: files[0]?.file ?? "";
	let summary = useMemo(() => total(files), [files]);
	let duplicates = useMemo(() => duplicateNames(files), [files]);
	let repeated = useMemo(() => regrouped(files), [files]);
	let index = useMemo(() => new Map(files.map(file => [id(file), file])), [files]);
	let paths = useMemo(() => files.map(file => id(file)), [files]);
	let decorations = useMemo(
		() =>
			new Map(
				files.map(file => [id(file), {
					text: fixed(file) ? file.note || "Binary" : `+${file.adds} -${file.dels}`,
					title: fixed(file)
						? file.note || "Binary file"
						: `${plural(file.adds, "addition", "additions")}, ${
							plural(file.dels, "deletion", "deletions")
						}`,
				}]),
			),
		[files],
	);
	let view = mode ?? internalMode;
	let options = useMemo(() => option(view), [view]);
	let expandable = useMemo(() => files.filter(file => !fixed(file)), [files]);
	let allExpanded = expandable.length > 0 && expandable.every(file => !collapsed.has(id(file)));
	let snapshot = useMemo(() => {
		let previous = new Map(cache.current);
		let next = new Map<string, Cache>();
		let items: CodeViewItem[] = [];
		for (let file of files) {
			let open = !fixed(file) && !collapsed.has(id(file));
			let value = item(file, open, previous);
			let hit = previous.get(id(file));
			if (hit) next.set(id(file), hit);
			items.push(value);
		}
		return { cache: next, items };
	}, [collapsed, files]);
	let { items } = snapshot;
	useLayoutEffect(() => {
		cache.current = snapshot.cache;
	}, [snapshot]);

	let scrollTo = useCallback((file: string) => {
		requestAnimationFrame(() => {
			code.current?.scrollTo({
				type: "item",
				id: file,
				align: "start",
				behavior: "smooth-auto",
			});
		});
	}, []);

	let select = useCallback((file: string) => {
		setNavigation(previous => ({ ...previous, current: file, pending: file }));
		onSelectedChange?.(file);
	}, [onSelectedChange]);

	let activate = useCallback((file: string, scroll = false) => {
		select(file);
		if (scroll) scrollTo(file);
	}, [scrollTo, select]);

	let load = useEffectEvent((file: string) => onFileOpen?.(index.get(file)!));
	useEffect(() => {
		if (!navigation.request) return;
		// This requests lazy patch I/O for a navigation intent. Selection and expansion
		// are already synchronized above; the callback does not return derived view data.
		load(navigation.request.file);
		scrollTo(navigation.request.file);
	}, [navigation.request, scrollTo]);

	function fileOpen(file: DiffViewFile) {
		return !fixed(file) && !collapsed.has(id(file));
	}

	function toggleFile(file: DiffViewFile, open: boolean) {
		select(id(file));
		if (fixed(file)) return;
		if (!open) onFileOpen?.(file);
		setCollapsed(previous => {
			let next = new Set(previous);
			if (open) next.add(id(file));
			else next.delete(id(file));
			return next;
		});
	}

	function toggleMode() {
		let next: DiffViewMode = view === "unified" ? "split" : "unified";
		setInternalMode(next);
		onModeChange?.(next);
	}

	function toggleAll() {
		if (!allExpanded) { for (let file of expandable) onFileOpen?.(file); }
		setCollapsed(allExpanded ? new Set(expandable.map(id)) : new Set());
	}

	let header = (item: CodeViewItem) => {
		let file = index.get(item.id);
		if (!file) return null;
		let open = fileOpen(file);
		return (
			<Header
				active={item.id === active}
				file={file}
				open={open}
				subtitle={context(file, duplicates)}
				group={repeated.has(file.file) ? file.group : undefined}
				onToggle={toggleFile}
			/>
		);
	};

	useLayoutEffect(() => {
		let view = code.current?.getInstance();
		if (!view || view.config.overscrollSize === BUFFER) return;
		// Keep fast momentum scrolls inside CodeView's rendered window.
		view.config.overscrollSize = BUFFER;
		view.render(true);
	}, []);

	return {
		files,
		base,
		head,
		pr,
		creatingPr,
		preparingPr,
		onOpenPr,
		onCreatePr,
		onCreateDraftPr,
		onManualCreatePr,
		actions,
		className,
		summary,
		view,
		toggleMode,
		allExpanded,
		toggleAll,
		expandable,
		treeOpen,
		setTreeOpen,
		paths,
		active,
		activate,
		decorations,
		code,
		items,
		options,
		header,
	};
}

function DiffViewContent(props: DiffViewProps & { kept: Kept }) {
	let {
		files,
		base,
		head,
		pr,
		creatingPr,
		preparingPr,
		onOpenPr,
		onCreatePr,
		onCreateDraftPr,
		onManualCreatePr,
		actions,
		className,
		summary,
		view,
		toggleMode,
		allExpanded,
		toggleAll,
		expandable,
		treeOpen,
		setTreeOpen,
		paths,
		active,
		activate,
		decorations,
		code,
		items,
		options,
		header,
	} = useDiffView(props);
	if (files.length === 0) {
		return (
			<section
				className={cn(
					"grid h-full min-h-0 place-items-center rounded-lg border border-border bg-background text-sm text-muted-foreground",
					className,
				)}
			>
				No file changes
			</section>
		);
	}

	return (
		<section
			className={cn(
				"@container/diff flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground",
				className,
			)}
		>
			<header className="flex h-9 shrink-0 items-center gap-3 border-b border-border py-0.5 pr-1 pl-3">
				<div className="flex min-w-0 flex-1 items-center gap-4">
					<div className="flex min-w-0 items-center gap-2 text-xs font-medium">
						<IconFileDiff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
						<span className="min-w-0 truncate">{head}</span>
						<span className="shrink-0 text-muted-foreground">-&gt;</span>
						<span className="min-w-0 truncate text-muted-foreground">{base}</span>
					</div>
					{summary.map(sum => (
						<div
							key={sum.group || ""}
							className="flex shrink-0 items-center gap-2 text-xs font-medium tabular-nums"
						>
							{sum.group ? <span className="text-muted-foreground">{sum.group}</span> : null}
							{sum.fixed
								? (
									<span className="font-normal text-muted-foreground">
										{plural(sum.files, "file", "files")}
									</span>
								)
								: null}
							{sum.fixed && !sum.adds && !sum.dels ? null : (
								<>
									<span className="text-accent">+{sum.adds}</span>
									<span className="text-destructive">-{sum.dels}</span>
								</>
							)}
						</div>
					))}
				</div>
				<TooltipProvider>
					<div className="flex shrink-0 items-center gap-1.5">
						{actions?.map((action) => (
							<GitActionButton key={action.label} action={action} variant="outline" />
						))}
						<PrAction
							pr={pr}
							creatingPr={creatingPr}
							preparingPr={preparingPr}
							onOpenPr={onOpenPr}
							onCreatePr={onCreatePr}
							onCreateDraftPr={onCreateDraftPr}
							onManualCreatePr={onManualCreatePr}
						/>
						<ToolButton
							label={view === "unified" ? "Switch to split diff" : "Switch to unified diff"}
							pressed={view === "split"}
							onClick={toggleMode}
						>
							{view === "unified"
								? <IconSplitView aria-hidden />
								: <IconRows aria-hidden />}
						</ToolButton>
						{expandable.length
							? (
								<ToolButton
									label={allExpanded ? "Collapse all diffs" : "Expand all diffs"}
									pressed={allExpanded}
									onClick={toggleAll}
								>
									{allExpanded
										? <IconCollapseVertical aria-hidden />
										: <IconExpandVertical aria-hidden />}
								</ToolButton>
							)
							: null}
						<ToolButton
							label={treeOpen ? "Hide file tree" : "Show file tree"}
							pressed={treeOpen}
							onClick={() => setTreeOpen(open => !open)}
						>
							<IconListTree aria-hidden />
						</ToolButton>
					</div>
				</TooltipProvider>
			</header>

			<div
				className={cn(
					"grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_0rem] @max-[46rem]/diff:grid-cols-1 @max-[46rem]/diff:grid-rows-[minmax(0,1fr)_0rem]",
					treeOpen
						&& "grid-cols-[minmax(0,1fr)_16rem] @max-[46rem]/diff:grid-rows-[minmax(0,1fr)_16rem]",
				)}
			>
				<main className="min-h-0 min-w-0 overflow-hidden scheme-light dark:scheme-dark">
					<CodeView
						ref={code}
						items={items}
						options={options}
						renderCustomHeader={header}
						className="h-full w-full overflow-x-hidden overflow-y-auto overscroll-contain outline-none"
					/>
				</main>

				<FileTreeShell open={treeOpen}>
					{treeOpen
						? (
							<FileTree
								paths={paths}
								selected={active}
								expand="all"
								decorations={decorations}
								onSelect={file => activate(file, true)}
							/>
						)
						: null}
				</FileTreeShell>
			</div>
		</section>
	);
}

export { DiffView };
export type { DiffViewFile, DiffViewMode, DiffViewPr, DiffViewProps };
