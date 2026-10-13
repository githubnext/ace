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
	onAction?: (event: ActionEvent) => void;
};

type Item = {
	label: string;
	action: Action;
	icon: ComponentType<{ className?: string }>;
};

const GROUPS: Item[][] = [
	[
		{ label: "Bold", action: "bold", icon: BoldIcon },
		{ label: "Italic", action: "italic", icon: ItalicIcon },
		{ label: "Underline", action: "underline", icon: UnderlineIcon },
		{ label: "Strikethrough", action: "strike", icon: StrikeIcon },
	],
	[
		{ label: "Link", action: "link", icon: LinkIcon },
	],
	[
		{ label: "Ordered list", action: "ordered", icon: OrderedIcon },
		{ label: "Bullet list", action: "bullet", icon: BulletIcon },
		{ label: "Blockquote", action: "quote", icon: BlockquoteIcon },
	],
	[
		{ label: "Inline code", action: "code", icon: CodeIcon },
		{ label: "Code block", action: "pre", icon: CodeBlockIcon },
	],
	[
		{ label: "Attach", action: "attach", icon: AttachIcon },
		{ label: "Emoji", action: "emoji", icon: EmojiIcon },
	],
];

function ToolbarButton(
	{ label, action, icon: Icon, disabled, onAction }: Item & {
		disabled?: boolean;
		onAction?: (event: ActionEvent) => void;
	},
) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Toolbar.Button
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={disabled}
								className="text-muted-foreground"
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
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

function ComposerToolbar({ className, disabled, onAction }: Props) {
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
