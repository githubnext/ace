import type { ComponentType } from "react";

import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { DropdownMenuItem } from "../ui/dropdown-menu";
import { SplitButton } from "../ui/split-button";
import { LoadingSpinner } from "./session-item/session-item-loading";

type Icon = ComponentType<{ className?: string }>;

/** Something a branch or its pull request could have done next, such as merging. */
export type GitAction = {
	label: string;
	icon: Icon;
	/** The icon's color class. */
	tone?: string;
	/** Shown after the label, such as how many commits a rebase brings in. */
	count?: string;
	title?: string;
	/** Underway: the button shows a spinner and can't be clicked again. */
	pending?: boolean;
	onClick?: () => void;
	/** Less common actions, in the button's menu. */
	menu?: { label: string; icon: Icon; onClick: () => void }[];
};

/** One action as a button, split when it has a menu; callers style it for where it sits. */
export function GitActionButton({ action, variant, className, primaryClassName }: {
	action: GitAction;
	variant: "ghost" | "outline";
	className?: string;
	primaryClassName?: string;
}) {
	const { label, icon: Glyph, tone, count, title, pending, onClick, menu } = action;
	const content = (
		<>
			{pending
				? (
					<span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
						<LoadingSpinner size={14} />
					</span>
				)
				: <Glyph className={cn("size-4 shrink-0", tone || "text-muted-foreground")} aria-hidden />}
			<span className="min-w-0 truncate">{label}</span>
			{count && !pending && (
				<span className="ml-auto shrink-0 font-medium text-muted-foreground tabular-nums">
					{count}
				</span>
			)}
		</>
	);
	const primary = cn("disabled:opacity-100", primaryClassName);
	if (!menu?.length) {
		return (
			<Button
				type="button"
				variant={variant}
				size="sm"
				title={title}
				className={cn(className, primary)}
				disabled={pending || !onClick}
				onClick={onClick}
			>
				{content}
			</Button>
		);
	}
	return (
		<SplitButton
			type="button"
			variant={variant}
			size="sm"
			title={title}
			className={className}
			primaryClassName={primary}
			triggerClassName="text-muted-foreground disabled:opacity-100"
			contentClassName="inline-[max-content]"
			disabled={pending || !onClick}
			onClick={onClick}
			menu={menu.map((item) => (
				<DropdownMenuItem key={item.label} onClick={item.onClick}>
					<item.icon className="size-4 text-muted-foreground" aria-hidden />
					<span>{item.label}</span>
				</DropdownMenuItem>
			))}
			menuLabel={`${label} options`}
		>
			{content}
		</SplitButton>
	);
}
