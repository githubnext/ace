import { useState } from "react";
import type { Event } from "../../types";

import { lookupCustomEmoji } from "../../lib/emoji";
import { cn } from "../../lib/utils";
import {
	Popover,
	PopoverPopup,
	PopoverPortal,
	PopoverPositioner,
	PopoverTrigger,
} from "../../ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../ui/tooltip";

/** Identifier shape used to highlight chips and own reactions. */
type CurrentUser = Event.Viewer;

type ReactionsProps = {
	/** Flat reactions array from the message event. */
	reactions: Event.Message.Reaction[];
	/** Which edge stays fixed as stacked chips expand. */
	align?: "left" | "right";
	/** Current user — chips that include this user render with a highlighted style. */
	currentUser?: CurrentUser;
	/** Called when a chip is clicked. */
	onReact?: (emoji: string) => void;
	/** Reports overflow popover state to the parent so hover affordances stay mounted. */
	onOpenChange?: (open: boolean) => void;
	className?: string;
};

type Chip = { emoji: string; count: number; mine: boolean; users: Event.Message.Reaction[] };
type Entry = { count: number; mine: boolean; seen: Set<string>; users: Event.Message.Reaction[] };

/** Custom-emoji shortcode pattern: `:id:` (mirrors what the emoji-mart picker emits). */
const SHORTCODE = /^:([\w-]+):$/;
const LIMIT = 8;

/** Render a single emoji string — image for custom shortcodes, text for unicode. */
function EmojiGlyph({ emoji }: { emoji: string }) {
	let m = SHORTCODE.exec(emoji);
	if (m) {
		let custom = lookupCustomEmoji(m[1]!);
		if (custom) {
			return <img src={custom.src} alt={custom.alt} className="size-3.5 object-contain" />;
		}
	}
	return <span>{emoji}</span>;
}

/** Match verified author IDs exclusively when the native caller provides them. */
function isMine(from: Event.Message.Reaction["from"], me?: CurrentUser): boolean {
	if (!me) return false;
	if (me.own) return me.own.includes(from);
	if (from === me.login) return true;
	return me.id !== undefined && from === String(me.id);
}

/** Group reactions by emoji into ordered chips, flagging chips the current user is part of. */
function group(reactions: Event.Message.Reaction[], me?: CurrentUser): Chip[] {
	let map = new Map<string, Entry>();
	for (let r of reactions) {
		let entry = map.get(r.emoji);
		let mine = isMine(r.from, me);
		let from = String(r.from);
		if (entry) {
			entry.count++;
			if (mine) entry.mine = true;
			if (!entry.seen.has(from)) {
				entry.seen.add(from);
				entry.users.push(r);
			}
		} else {
			map.set(r.emoji, { count: 1, mine, seen: new Set([from]), users: [r] });
		}
	}
	return Array.from(map, ([emoji, { count, mine, users }]) => ({ emoji, count, mine, users }));
}

/** Format the tooltip text listing who reacted with an emoji. */
function reactors(users: Event.Message.Reaction[], me?: CurrentUser): string {
	let names = users.map(reaction => name(reaction, me));
	let mine = names.indexOf("You");
	if (mine > 0) {
		names.splice(mine, 1);
		names.unshift("You");
	}
	if (names.length === 1) return names[0]!;
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
	return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

function name(reaction: Event.Message.Reaction, me?: CurrentUser): string {
	return isMine(reaction.from, me) ? "You" : reaction.display || String(reaction.from);
}

/** Static class strings indexed by tier — Tailwind needs literal class names. */
const SIZE = {
	wide: "w-14 px-2",
	mid: "w-12 px-2",
	digit: "w-9 px-1.5",
} as const;
const STACK = {
	right: { wide: "-mr-10", mid: "-mr-8", digit: "-mr-5" },
	left: { wide: "-ml-10", mid: "-ml-8", digit: "-ml-5" },
} as const;
const SLIDE = {
	right: "group-hover/reactions:mr-0.5 group-data-[popup-open]/reactions:mr-0.5",
	left: "group-hover/reactions:ml-0.5 group-data-[popup-open]/reactions:ml-0.5",
} as const;

function tier(count: number): keyof typeof SIZE {
	if (count > 99) return "wide";
	if (count > 9) return "mid";
	return "digit";
}

function size(count: number): string {
	return SIZE[tier(count)];
}

function stack(count: number, right: boolean): string {
	let t = tier(count);
	return right ? `${STACK.right[t]} ${SLIDE.right}` : `${STACK.left[t]} ${SLIDE.left}`;
}

/**
 * Stacked reaction pills — chips overlap by default and slide apart on hover.
 * Clicking a chip toggles the current user's reaction for that emoji.
 */
function Reactions(
	{ reactions, align = "left", currentUser, onReact, onOpenChange, className }: ReactionsProps,
) {
	let [more, setMore] = useState(false);
	function handleMoreChange(o: boolean) {
		setMore(o);
		onOpenChange?.(o);
	}

	let chips = group(reactions, currentUser);
	let shown = chips.slice(0, LIMIT);
	let hidden = chips.slice(LIMIT);
	let total = hidden.reduce((sum, chip) => sum + chip.count, 0);
	let hiddenEmoji = new Set(hidden.map(chip => chip.emoji));
	let extra = hidden.length ? reactions.filter(reaction => hiddenEmoji.has(reaction.emoji)) : [];
	let right = align === "right";
	if (!chips.length) return null;
	return (
		<TooltipProvider>
			<div
				data-popup-open={more || undefined}
				className={cn(
					"group/reactions flex h-5.5 w-fit -translate-y-2 -mb-2",
					right && "flex-row-reverse",
					className,
				)}
			>
				{shown.map(({ emoji, count, mine, users }, i) => (
					<Tooltip key={emoji}>
						<TooltipTrigger
							render={
								<button
									type="button"
									aria-pressed={mine}
									onClick={() => onReact?.(emoji)}
									className={cn(
										"relative h-5.5 shrink-0 rounded-full text-xs leading-none flex items-center justify-center gap-1 transition-[margin-left,margin-right,background-color] duration-200",
										i > 0 && stack(shown[i - 1]!.count, right),
										size(count),
										mine
											? "border border-[oklch(from_var(--success)_l_calc(c_*_0.5)_h_/_0.6)] bg-[oklch(from_color-mix(in_oklch,var(--success)_22%,var(--background))_calc(l_+_0.03)_c_h)] hover:bg-[oklch(from_color-mix(in_oklch,var(--success)_30%,var(--background))_calc(l_+_0.03)_c_h)]"
											: "border border-border bg-muted hover:bg-secondary",
									)}
								/>
							}
						>
							<EmojiGlyph emoji={emoji} />
							<span className="text-foreground/70 font-semibold tabular-nums">{count}</span>
						</TooltipTrigger>
						<TooltipContent>{reactors(users, currentUser)}</TooltipContent>
					</Tooltip>
				))}
				{hidden.length > 0 && (
					<Popover open={more} onOpenChange={handleMoreChange}>
						<PopoverTrigger
							render={
								<button
									type="button"
									aria-label={`${total} more reactions`}
									className={cn(
										"relative h-5.5 min-w-5.5 px-1.5 rounded-full bg-muted hover:bg-secondary text-xs font-semibold text-muted-foreground tabular-nums flex items-center justify-center transition-[margin-left,margin-right,background-color] duration-200",
										stack(shown.at(-1)?.count || 1, right),
									)}
								/>
							}
						>
							+{total}
						</PopoverTrigger>
						<PopoverPortal>
							<PopoverPositioner side="top" align={right ? "end" : "start"} sideOffset={8}>
								<PopoverPopup
									className="inline-48 max-block-56 overflow-y-auto p-1"
									initialFocus={false}
									finalFocus={false}
								>
									<div className="flex flex-col">
										{extra.map(reaction => (
											<button
												key={`${reaction.emoji}-${reaction.from}`}
												type="button"
												onClick={() => onReact?.(reaction.emoji)}
												className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs outline-none hover:bg-secondary focus-visible:bg-secondary"
											>
												<span className="flex size-5 items-center justify-center rounded-full bg-muted">
													<EmojiGlyph emoji={reaction.emoji} />
												</span>
												<span className="min-w-0 truncate text-muted-foreground leading-none">
													{name(reaction, currentUser)}
												</span>
											</button>
										))}
									</div>
								</PopoverPopup>
							</PopoverPositioner>
						</PopoverPortal>
					</Popover>
				)}
			</div>
		</TooltipProvider>
	);
}

export { Reactions };
export type { ReactionsProps };
