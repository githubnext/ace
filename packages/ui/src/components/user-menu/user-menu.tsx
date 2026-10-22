import {
	type ComponentPropsWithRef,
	type FocusEvent,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	useRef,
	useState,
} from "react";
import * as format from "../../lib/format";

import { Avatar, AvatarFallback, AvatarImage } from "../../ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { cn } from "../../lib/utils";

type Props = Omit<ComponentPropsWithRef<"button">, "children"> & {
	/** Display name used for the avatar alt text and fallback. */
	name: string;
	/** GitHub handle, when the current identity has been linked to GitHub. */
	handle?: string;
	/** Avatar image URL; defaults to the GitHub avatar for `handle`. */
	avatar?: string;
	/** Alignment for the dropdown content. */
	align?: "start" | "center" | "end";
	/** Side for the dropdown content. */
	side?: "top" | "right" | "bottom" | "left" | "inline-start" | "inline-end";
	/** Fires when the GitHub profile item is selected. */
	onProfile?: () => void;
	/** Fires when the Settings item is selected. */
	onSettings?: () => void;
	/** Extra menu items rendered below Settings. */
	children?: ReactNode;
};

/** Two-letter avatar fallback derived from the display name. */
function initials(name: string) {
	let parts = name.trim().split(/\s+/);
	let head = parts[0]?.[0] ?? "";
	let tail = parts.length > 1 ? parts[parts.length - 1]![0] : "";
	return (head + tail).toUpperCase() || "?";
}

/** Avatar trigger that opens a dropdown with account actions. */
function UserMenu({
	name,
	handle,
	avatar = handle && format.avatar(handle),
	align = "start",
	side = "bottom",
	onProfile,
	onSettings,
	children,
	className,
	"aria-label": label = "Open account menu",
	onBlurCapture,
	onFocusCapture,
	onKeyDownCapture,
	onPointerDownCapture,
	ref,
	...rest
}: Props) {
	let [active, setActive] = useState(false);
	let pointer = useRef(false);
	let profile = onProfile || (handle
		? () => window.open(`https://github.com/${handle}`, "_blank", "noopener,noreferrer")
		: undefined);

	function enter(event: FocusEvent<HTMLButtonElement>) {
		let visible = event.currentTarget.matches(":focus-visible");
		if (visible) pointer.current = false;
		setActive(visible);
		onFocusCapture?.(event);
	}

	function leave(event: FocusEvent<HTMLButtonElement>) {
		setActive(false);
		onBlurCapture?.(event);
	}

	function press(event: PointerEvent<HTMLButtonElement>) {
		pointer.current = true;
		onPointerDownCapture?.(event);
	}

	function key(event: KeyboardEvent<HTMLButtonElement>) {
		pointer.current = false;
		onKeyDownCapture?.(event);
	}

	function focus() {
		let restore = !pointer.current;
		pointer.current = false;
		return restore;
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={ref}
				aria-label={label}
				className={cn(
					"group flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full select-none",
					"transition-[scale] duration-150 ease-out will-change-transform active:scale-[0.96] data-[popup-open]:scale-[0.98] motion-reduce:scale-100 motion-reduce:transition-none",
					"focus-visible:outline-none",
					className,
				)}
				onBlurCapture={leave}
				onFocusCapture={enter}
				onKeyDownCapture={key}
				onPointerDownCapture={press}
				{...rest}
			>
				<span className="relative grid size-7.75 shrink-0 place-items-center rounded-full">
					<Avatar className="size-full rounded-full border-0 bg-transparent ring-0">
						{avatar && <AvatarImage src={avatar} alt={name} />}
						<AvatarFallback className="bg-transparent">{initials(name)}</AvatarFallback>
					</Avatar>
					<span
						aria-hidden="true"
						className={cn(
							"pointer-events-none absolute inset-0 rounded-full outline-2 outline-offset-[-2px] outline-transparent",
							active && "outline-ring",
						)}
					/>
				</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align={align}
				side={side}
				sideOffset={8}
				className="inline-[max-content] max-inline-[calc(100vw-1rem)]"
				finalFocus={focus}
			>
				<DropdownMenuGroup>
					<DropdownMenuItem onClick={profile} disabled={!profile}>GitHub profile</DropdownMenuItem>
					<DropdownMenuItem onClick={onSettings} disabled={!onSettings}>Settings</DropdownMenuItem>
					{children}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export { UserMenu };
