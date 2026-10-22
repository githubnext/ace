import { memo, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../ui/dialog";

import { filterCommandPaletteItems, firstEnabled } from "./filter";
import type { CommandPaletteItem, CommandPaletteModifier, CommandPaletteShortcut } from "./types";

export type CommandPaletteProps = {
	open: boolean;
	items: CommandPaletteItem[];
	onOpenChange: (open: boolean) => void;
	onSelect: (item: CommandPaletteItem) => void;
	placeholder?: string;
	emptyLabel?: string;
	title?: string;
	description?: string;
	className?: string;
};

function mac() {
	if (typeof navigator === "undefined") return false;
	let ua = (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData;
	return ua ? /mac/i.test(ua.platform) : /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

const apple = mac();

const glyphs = {
	meta: "⌘",
	ctrl: apple ? "⌃" : "Ctrl+",
	mod: apple ? "⌘" : "Ctrl+",
	alt: apple ? "⌥" : "Alt+",
	shift: apple ? "⇧" : "Shift+",
} satisfies Record<CommandPaletteModifier, string>;

function shortcutLabel(shortcut?: CommandPaletteShortcut) {
	if (!shortcut) return;
	if (shortcut.label) return shortcut.label;
	let mods = shortcut.modifiers?.map(mod => glyphs[mod]).join("") || "";
	let key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
	return `${mods}${key}`;
}

function statusLabel(item: CommandPaletteItem) {
	if (item.kind !== "session") return shortcutLabel(item.shortcut);
	if (item.archived) return "Archived";
	if (item.status === "attention") return "Needs you";
	if (item.status === "mention") return "Mention";
	if (item.status === "unread") return "Unread";
	if (item.status === "busy") return "Busy";
}

export const CommandPalette = memo(function CommandPalette({
	open,
	items,
	onOpenChange,
	onSelect,
	placeholder = "Type a command...",
	emptyLabel = "No commands found",
	title = "Command Palette",
	description = "Search commands and sessions",
	className,
}: CommandPaletteProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				showCloseButton={false}
				className={cn(
					"grid h-[min(34rem,var(--dialog-max))] w-[min(44rem,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden sm:max-w-none rounded-2xl border border-border/70 bg-popover/95 p-0 shadow-modal supports-backdrop-filter:backdrop-blur-xl",
					className,
				)}
			>
				<DialogTitle className="sr-only">{title}</DialogTitle>
				<DialogDescription className="sr-only">{description}</DialogDescription>

				<Palette
					key={String(open)}
					items={items}
					onOpenChange={onOpenChange}
					onSelect={onSelect}
					placeholder={placeholder}
					emptyLabel={emptyLabel}
					title={title}
				/>
			</DialogContent>
		</Dialog>
	);
});

function Palette({ items, onOpenChange, onSelect, placeholder, emptyLabel, title }: Pick<
	CommandPaletteProps,
	"items" | "onOpenChange" | "onSelect" | "placeholder" | "emptyLabel" | "title"
>) {
	let [query, setQuery] = useState("");
	let [selected, setSelected] = useState<string>();
	let list = useRef<HTMLDivElement>(null);
	let results = useMemo(() => filterCommandPaletteItems(items, query), [items, query]);
	let index = results.findIndex(({ item }) => item.id === selected && !item.disabled);
	if (index < 0) index = firstEnabled(results);

	function move(delta: number) {
		let enabled = results
			.map((result, i) => result.item.disabled ? -1 : i)
			.filter(i => i >= 0);
		if (!enabled.length) return;

		let current = enabled.indexOf(index);
		let next = current < 0 ? 0 : (current + delta + enabled.length) % enabled.length;
		setSelected(results[enabled[next]!]?.item.id);
	}

	function choose(item: CommandPaletteItem) {
		if (item.disabled) return;
		onSelect(item);
		onOpenChange(false);
	}

	function keydown(event: React.KeyboardEvent<HTMLInputElement>) {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			move(1);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			move(-1);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			let item = results[index]?.item;
			if (item) choose(item);
		}
	}

	function updateQuery(value: string) {
		let next = filterCommandPaletteItems(items, value);
		let idx = firstEnabled(next);
		setQuery(value);
		setSelected(idx >= 0 ? next[idx]?.item.id : undefined);
		list.current?.scrollTo({ top: 0 });
	}

	useEffect(() => {
		let id = results[index]?.item.id;
		if (!id) return;
		document.getElementById(`command-palette-${id}`)?.scrollIntoView({ block: "nearest" });
	}, [index, results]);

	return (
		<>
			<div className="border-b border-border/70">
				<input
					value={query}
					onChange={event => updateQuery(event.target.value)}
					onKeyDown={keydown}
					placeholder={placeholder}
					autoCorrect="off"
					autoCapitalize="off"
					spellCheck={false}
					aria-label={title}
					aria-controls="command-palette-results"
					aria-activedescendant={results[index]
						? `command-palette-${results[index]!.item.id}`
						: undefined}
					className="block w-full bg-transparent px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
				/>
			</div>

			<div
				ref={list}
				id="command-palette-results"
				role="listbox"
				className="min-h-0 overflow-y-auto p-2 overscroll-contain"
			>
				{results.length
					? (
						<div className="grid gap-0.5">
							{results.map(({ item }, i) => {
								let selected = i === index;
								let label = statusLabel(item);
								return (
									<button
										key={`${item.kind}:${item.id}`}
										id={`command-palette-${item.id}`}
										type="button"
										role="option"
										aria-selected={selected}
										disabled={item.disabled}
										onClick={() => choose(item)}
										onPointerEnter={() => !item.disabled && setSelected(item.id)}
										className={cn(
											"group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm/5 outline-none transition-[background-color,color,transform] duration-150 ease-out",
											selected && "bg-accent text-accent-foreground",
											!selected && "text-foreground",
											item.disabled && "cursor-not-allowed opacity-45",
										)}
									>
										<span className="min-inline-size-0 truncate">
											<span
												className={cn(
													"text-muted-foreground",
													selected && "text-accent-foreground/70",
												)}
											>
												{item.group}:
											</span>{" "}
											<span>{item.label}</span>
										</span>
										{label && (
											<span
												className={cn(
													"shrink-0 rounded border border-border/70 bg-background/80 px-1.5 py-0.5 font-mono text-[0.625rem]/none text-muted-foreground",
													item.kind === "session"
														&& (item.status === "mention" || item.status === "attention")
														&& "border-amber-500/30 text-amber-600 dark:text-amber-300",
													item.kind === "session" && item.status === "unread"
														&& "border-sky-500/30 text-sky-600 dark:text-sky-300",
													item.kind === "session" && item.status === "busy"
														&& "border-emerald-500/30 text-emerald-600 dark:text-emerald-300",
												)}
											>
												{label}
											</span>
										)}
									</button>
								);
							})}
						</div>
					)
					: (
						<div className="px-4 py-8 text-center text-sm text-muted-foreground">
							{emptyLabel}
						</div>
					)}
			</div>
		</>
	);
}
