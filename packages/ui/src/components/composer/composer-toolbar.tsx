import type { ComponentType } from "react";
import { Toolbar } from "@base-ui/react/toolbar";
import { Button } from "../../ui/button";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../ui/tooltip";
import {
	IconAttachMicro as AttachIcon,
	IconBoldMicro as BoldIcon,
	IconBulletListMicro as BulletIcon,
	IconCodeBlockMicro as CodeBlockIcon,
	IconCodeMicro as CodeIcon,
	IconEmojiMicro as EmojiIcon,
	IconItalicMicro as ItalicIcon,
	IconLinkMicro as LinkIcon,
	IconOrderedListMicro as OrderedIcon,
	IconQuoteMicro as BlockquoteIcon,
	IconStrikeMicro as StrikeIcon,
	IconUnderlineMicro as UnderlineIcon,
} from "../../icons";

type Action =
	| "bold"
	| "italic"
	| "underline"
	| "strike"
	| "link"
	| "ordered"
	| "bullet"
	| "quote"
	| "code"
	| "pre"
	| "emoji"
	| "attach";

type ActionEvent = {
	action: Action;
	trigger: HTMLElement;
};

type Props = {
	className?: string;
	disabled?: Partial<Record<Action, boolean>>;
	value?: Partial<Record<Action, boolean>>;
	onAction?: (event: ActionEvent) => void;
};

type Item = {
	label: string;
	action: Action;
	icon: ComponentType<{ className?: string }>;
	/** The editor's binding (rich-text.tsx), as Mod plus these keys. */
	keys?: string;
};

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** `Shift-s` reads ⇧⌘S on a Mac and Ctrl+Shift+S elsewhere. */
function shortcut(keys: string) {
	const parts = keys.split("-");
	const key = parts.pop()!.toUpperCase();
	if (!MAC) return ["Ctrl", ...parts, key].join("+");
	const glyphs: Record<string, string> = { Shift: "⇧", Alt: "⌥" };
	return `${parts.map((part) => glyphs[part]).join("")}⌘${key}`;
}

const GROUPS: Item[][] = [
	[
		{ label: "Bold", action: "bold", icon: BoldIcon, keys: "b" },
		{ label: "Italic", action: "italic", icon: ItalicIcon, keys: "i" },
		{ label: "Underline", action: "underline", icon: UnderlineIcon, keys: "u" },
		{ label: "Strikethrough", action: "strike", icon: StrikeIcon, keys: "Shift-s" },
	],
	[
		{ label: "Link", action: "link", icon: LinkIcon },
	],
	[
		{ label: "Ordered list", action: "ordered", icon: OrderedIcon, keys: "Alt-7" },
		{ label: "Bullet list", action: "bullet", icon: BulletIcon, keys: "Alt-8" },
		{ label: "Blockquote", action: "quote", icon: BlockquoteIcon, keys: "Shift-." },
	],
	[
		{ label: "Inline code", action: "code", icon: CodeIcon, keys: "e" },
		{ label: "Code block", action: "pre", icon: CodeBlockIcon, keys: "Alt-`" },
	],
	[
		{ label: "Attach", action: "attach", icon: AttachIcon },
		{ label: "Emoji", action: "emoji", icon: EmojiIcon },
	],
];

function ToolbarButton(
	{ label, action, icon: Icon, keys, active, disabled, onAction }: Item & {
		active?: boolean;
		disabled?: boolean;
		onAction?: (event: ActionEvent) => void;
	},
) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Toolbar.Button
						aria-label={label}
						aria-keyshortcuts={keys && `${MAC ? "Meta" : "Control"}+${keys.replaceAll("-", "+")}`}
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={disabled}
								className={cn(
									"text-muted-foreground",
									active && "bg-primary/15 text-foreground hover:bg-primary/25",
								)}
							/>
						}
						onMouseDown={(e) => {
							e.preventDefault();
						}}
						onClick={(e) => {
							if (disabled) return;
							onAction?.({ action, trigger: e.currentTarget });
						}}
					/>
				}
			>
				<Icon />
			</TooltipTrigger>
			<TooltipContent>
				{label}
				{keys && <kbd data-slot="kbd" className="font-sans opacity-60">{shortcut(keys)}</kbd>}
			</TooltipContent>
		</Tooltip>
	);
}

function ComposerToolbar({ className, disabled, value, onAction }: Props) {
	return (
		<TooltipProvider>
			<div
				data-axis="x"
				className={cn(
					"scroll-fade scrollbar-none w-full min-w-0 py-0.5 -my-0.5",
					className,
				)}
			>
				<Toolbar.Root
					aria-label="Composer tools"
					className="flex w-max flex-none flex-nowrap items-center gap-0.5"
				>
					{GROUPS.map((group, i) => (
						<Toolbar.Group key={group[0]!.action} className="flex shrink-0 items-center gap-0.5">
							{group.map((item) => (
								<ToolbarButton
									key={item.action}
									{...item}
									active={value?.[item.action]}
									disabled={disabled?.[item.action]}
									onAction={onAction}
								/>
							))}
							{i < GROUPS.length - 1 && (
								<Toolbar.Separator className="mx-1 h-4 w-px shrink-0 bg-border" />
							)}
						</Toolbar.Group>
					))}
				</Toolbar.Root>
			</div>
		</TooltipProvider>
	);
}

export { type ActionEvent as ComposerToolbarEvent, ComposerToolbar };
