import type { ComponentPropsWithRef, ReactNode } from "react";
import { Toolbar } from "@base-ui/react/toolbar";
import { cn } from "../../lib/utils";
import { Badge } from "../../ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { useLayoutNavOptional } from "../layout/layout";

/**
 * Renders an anchor by default. Pass a router link through `render` (e.g. `render={<Link to="/" />}`)
 * to navigate client-side; a router that sets `data-status="active"` styles the link as current.
 */
type Props = ComponentPropsWithRef<typeof Toolbar.Link> & {
	icon?: ReactNode;
	hover?: boolean;
	/** Show a notification badge on the icon */
	badge?: boolean;
	/** Keyboard shortcut hint displayed when nav is expanded */
	shortcut?: string;
	/** Marks the link as the current page. */
	active?: boolean;
};

/** A single navigation link in the sidebar. Collapses text automatically when the parent Nav is minimized via CSS. */
function NavListLink(
	{
		icon,
		hover,
		badge = false,
		shortcut,
		className,
		ref,
		children,
		active,
		...props
	}: Props,
) {
	let nav = useLayoutNavOptional();
	// Tooltip is only useful when the label is hidden — i.e. the nav is collapsed.
	// Without a Layout (e.g. standalone stories), label visibility is decided by
	// container width alone, so suppress the tooltip there too.
	let collapsed = nav?.open === false;

	return (
		<Tooltip disabled={!collapsed || !children}>
			<TooltipTrigger
				render={
					<Toolbar.Link
						ref={ref}
						data-hover={hover || undefined}
						{...(active && { "data-status": "active" })}
						className={cn(
							// layout
							"group relative inline-flex items-center gap-0.5 whitespace-nowrap contain-layout cursor-default",
							// sizing
							"max-sm:h-8 max-sm:px-1 sm:m-px sm:h-[calc(var(--spacing)*8-2px)] sm:w-[calc(var(--spacing)*8-2px)] sm:@min-[5rem]/nav:w-[calc(100%-2px)]",
							// appearance
							"rounded-lg squircle border border-transparent bg-clip-padding outline-none select-none",
							// color
							"text-xs/relaxed font-medium",
							// hover
							"sm:hover:bg-background/50",
							"sm:data-hover:bg-background/50",
							"sm:hover:backdrop-blur-[1px]",
							"sm:data-hover:backdrop-blur-[1px]",
							// active
							"data-[status=active]:bg-popover/35 dark:data-[status=active]:bg-black/32",
							"data-[status=active]:backdrop-blur-[1px]",
							"data-[status=active]:selected-surface",
							"data-[status=active]:text-accent-text",
							// focus — inset ring to avoid clipping by nav's contain:paint
							"focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30",
							"data-[status=active]:focus-visible:ring-accent/30",
							// disabled
							"disabled:pointer-events-none disabled:opacity-50",
							// transition
							"transition-[color,box-shadow] duration-150",
							className,
						)}
						{...props}
					/>
				}
			>
				<span className="relative z-1 @container grid h-full aspect-square place-items-center shrink-0 text-muted-foreground group-data-[status=active]:text-current/80 [&>svg]:size-4.5 [&_svg]:pointer-events-none [&_svg]:shrink-0">
					<Badge show={badge}>{icon}</Badge>
				</span>
				{children && (
					<span
						className={cn(
							"relative z-1 text-xs font-medium pr-2 sm:opacity-0 sm:@min-[5rem]/nav:opacity-100 sm:text-sm",
							// A phone's tab bar fits every icon and the account button by naming only the current page.
							"max-[26rem]:sr-only max-[26rem]:group-data-[status=active]:not-sr-only",
							"transition-opacity duration-200 ease-in-out",
						)}
					>
						{children}
					</span>
				)}
				{shortcut && (
					<kbd className="relative z-1 ml-auto mr-1 hidden h-4.5 items-center justify-center rounded-[5px] border border-black/10 dark:border-white/10 bg-background px-1.5 text-[0.625rem] text-muted-foreground font-medium leading-none sm:@min-[5rem]/nav:group-hover:inline-flex sm:@min-[5rem]/nav:group-focus-visible:inline-flex sm:@min-[5rem]/nav:group-data-hover:inline-flex">
						{shortcut}
					</kbd>
				)}
			</TooltipTrigger>
			<TooltipContent side="right" sideOffset={8}>
				{children}
			</TooltipContent>
		</Tooltip>
	);
}

export { NavListLink };
