import { pick } from "../../lib/emoji";
import { type ComponentPropsWithRef, useRef, useState } from "react";

import { MessageToolbarButton } from "./message-toolbar-button";
import { cn } from "../../lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { EmojiPicker } from "../../ui/emoji-picker";
import {
	Popover,
	PopoverPopup,
	PopoverPortal,
	PopoverPositioner,
	PopoverTrigger,
} from "../../ui/popover";
import { IconCopy, IconDots, IconLinkMicro, IconPencil, IconReact, IconTrash } from "../../icons";

type MessageToolbarProps = Omit<ComponentPropsWithRef<"div">, "onSelect"> & {
	/** Which edge the overflow menu should align to. */
	align?: "left" | "right";
	/** Whether the active message belongs to the current user — controls edit/delete visibility. */
	mine?: boolean;
	/** Whether the active message may be edited. Defaults to `mine`. */
	canEdit?: boolean;
	/** Disable unavailable actions while retaining the existing toolbar and menu. */
	actions?: Partial<Record<MessageToolbarAction["type"], boolean>>;
	/** Called when the user picks a toolbar action. */
	onAction: (action: MessageToolbarAction) => void;
	/** Reports picker/menu open state to the parent so it can keep the toolbar mounted. */
	onOpenChange?: (open: boolean) => void;
};

type MessageToolbarAction =
	| { type: "copy" }
	| { type: "delete" }
	| { type: "edit" }
	| { type: "permalink" }
	| { type: "react"; emoji: string };

/**
 * Compact message action strip shown in the timeline action row.
 */
function MessageToolbar(
	{
		align = "right",
		className,
		mine,
		canEdit = mine,
		actions,
		onAction,
		onOpenChange,
		...props
	}: MessageToolbarProps,
) {
	let [open, setOpen] = useState(false);
	let [menu, setMenu] = useState(false);
	let [popup, setPopup] = useState(false);
	let button = useRef<HTMLButtonElement | null>(null);
	let edit = mine && canEdit;
	// A deleted message, or one in an archived channel, can't be deleted, so More drops Delete.
	let remove = mine && actions?.delete !== false;

	function handleOpenChange(o: boolean) {
		setOpen(o);
		onOpenChange?.(o || menu);
	}

	function handleMenuChange(o: boolean) {
		setMenu(o);
		onOpenChange?.(open || o);
	}

	function showPicker() {
		setPopup(true);
		setMenu(false);
		setOpen(true);
		onOpenChange?.(true);
	}

	return (
		<div
			className={cn(
				"inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border/70 bg-popover/95 p-0.5 text-popover-foreground shadow-[0_1px_2px_rgb(0_0_0/.08),0_4px_10px_-6px_rgb(0_0_0/.28)] backdrop-blur-md pointer-events-auto dark:border-white/12 dark:shadow-[0_1px_2px_rgb(0_0_0/.28),0_6px_14px_-8px_rgb(0_0_0/.65)]",
				align === "left" && "flex-row-reverse",
				className,
			)}
			{...props}
		>
			<Popover open={open} onOpenChange={handleOpenChange}>
				<PopoverTrigger
					render={
						<MessageToolbarButton
							aria-label="Add reaction"
							disabled={actions?.react === false}
							className="hidden notouch:flex"
							icon={<IconReact className="size-3.5" />}
							onClick={() => setPopup(false)}
						/>
					}
				/>
				<PopoverPortal>
					<PopoverPositioner
						anchor={popup ? button.current ?? undefined : undefined}
						side="top"
						align={align === "right" ? "end" : "start"}
						sideOffset={8}
					>
						<PopoverPopup
							className="overflow-hidden p-0"
							initialFocus={false}
							finalFocus={false}
						>
							<EmojiPicker
								onSelect={(e) => {
									onAction({ type: "react", emoji: pick(e) });
									handleOpenChange(false);
								}}
							/>
						</PopoverPopup>
					</PopoverPositioner>
				</PopoverPortal>
			</Popover>
			<MessageToolbarButton
				onClick={() => {
					onAction({ type: "copy" });
				}}
				aria-label="Copy"
				disabled={actions?.copy === false}
				className="hidden notouch:flex"
				icon={<IconCopy className="size-3.5" />}
			/>
			<MessageToolbarButton
				onClick={() => {
					onAction({ type: "permalink" });
				}}
				aria-label="Copy message link"
				disabled={actions?.permalink === false}
				className="hidden notouch:flex"
				icon={<IconLinkMicro className="size-3.5" />}
			/>
			<DropdownMenu open={menu} onOpenChange={handleMenuChange}>
				<DropdownMenuTrigger
					render={
						<MessageToolbarButton
							ref={button}
							active={menu}
							aria-label="More"
							className={!edit && !remove ? "notouch:hidden" : undefined}
							icon={<IconDots className="size-3.5" />}
						/>
					}
				/>
				<DropdownMenuContent
					align={align === "right" ? "end" : "start"}
					side="bottom"
					sideOffset={6}
					className="inline-40"
				>
					<DropdownMenuGroup>
						<DropdownMenuItem
							className="notouch:hidden"
							onClick={showPicker}
							disabled={actions?.react === false}
						>
							<IconReact className="size-3.5" />
							Add reaction
						</DropdownMenuItem>
						<DropdownMenuItem
							className="notouch:hidden"
							onClick={() => {
								onAction({ type: "copy" });
							}}
							disabled={actions?.copy === false}
						>
							<IconCopy className="size-3.5" />
							Copy
						</DropdownMenuItem>
						<DropdownMenuItem
							className="notouch:hidden"
							onClick={() => {
								onAction({ type: "permalink" });
							}}
							disabled={actions?.permalink === false}
						>
							<IconLinkMicro className="size-3.5" />
							Copy link
						</DropdownMenuItem>
						{(edit || remove) && <DropdownMenuSeparator className="notouch:hidden" />}
						{edit && (
							<DropdownMenuItem
								onClick={() => {
									onAction({ type: "edit" });
								}}
								disabled={actions?.edit === false}
							>
								<IconPencil className="size-3.5" />
								Edit
							</DropdownMenuItem>
						)}
						{edit && remove && <DropdownMenuSeparator />}
						{remove && (
							<DropdownMenuItem
								variant="destructive"
								onClick={() => {
									onAction({ type: "delete" });
								}}
							>
								<IconTrash className="size-3.5" />
								Delete
							</DropdownMenuItem>
						)}
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

export { MessageToolbar };
export type { MessageToolbarAction, MessageToolbarProps };
