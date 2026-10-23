import type { ReactNode } from "react";

import { CreatePrMenu } from "../create-pr-menu";
import { LoadingSpinner } from "../session-item/session-item-loading";
import { Button } from "../../ui/button";
import { buttonVariants } from "../../lib/button-variants";
import { SplitButton } from "../../ui/split-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";

import type { DiffViewPr } from "./types";
import { IconMerge, IconPullRequest, IconPullRequestClosed } from "../../icons";

function PrIcon({ state }: { state: DiffViewPr["state"] }) {
	if (state === "closed") {
		return <IconPullRequestClosed className="size-4 text-destructive" aria-hidden />;
	}
	if (state === "merged") {
		return <IconMerge className="size-4 text-merged" aria-hidden />;
	}
	if (state === "draft") {
		return <IconPullRequest className="size-4 text-muted-foreground" aria-hidden />;
	}
	return <IconPullRequest className="size-4 text-accent" aria-hidden />;
}

function PrAction({
	pr,
	creatingPr = false,
	preparingPr = false,
	onOpenPr,
	onCreatePr,
	onCreateDraftPr,
}: {
	pr?: DiffViewPr;
	creatingPr?: boolean;
	preparingPr?: boolean;
	onOpenPr?: () => void;
	onCreatePr?: () => void;
	onCreateDraftPr?: () => void;
}) {
	if (pr) {
		let content = (
			<>
				<PrIcon state={pr.state} />
				<span>{pr.number}</span>
			</>
		);

		if (pr.url && !onOpenPr) {
			return (
				<a
					href={pr.url}
					target="_blank"
					rel="noreferrer"
					title={pr.title}
					className={buttonVariants({ variant: "outline", size: "sm" })}
				>
					{content}
				</a>
			);
		}

		return (
			<Button
				type="button"
				variant="outline"
				size="sm"
				title={pr.title}
				disabled={!onOpenPr}
				onClick={onOpenPr}
			>
				{content}
			</Button>
		);
	}

	let busy = creatingPr || preparingPr;
	let label = preparingPr ? "Preparing PR" : creatingPr ? "Creating PR" : "Create PR";

	if (!busy && !onCreatePr) return null;

	let content = (
		<>
			{busy
				? (
					<span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
						<LoadingSpinner size={14} />
					</span>
				)
				: null}
			<span>{label}</span>
		</>
	);

	if (onCreateDraftPr) {
		return (
			<SplitButton
				type="button"
				variant="outline"
				size="sm"
				primaryClassName="disabled:opacity-100"
				triggerClassName="disabled:opacity-100"
				contentClassName="inline-[max-content]"
				disabled={busy || !onCreatePr}
				onClick={onCreatePr}
				menu={
					<CreatePrMenu
						onCreateDraftPr={onCreateDraftPr}
					/>
				}
				menuLabel="Create PR options"
			>
				{content}
			</SplitButton>
		);
	}

	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			className="disabled:opacity-100"
			disabled={busy || !onCreatePr}
			onClick={onCreatePr}
		>
			{content}
		</Button>
	);
}

function ToolButton({
	label,
	pressed,
	onClick,
	children,
}: {
	label: string;
	pressed?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={label}
						aria-pressed={pressed}
						onClick={onClick}
					>
						{children}
					</Button>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

export { PrAction, ToolButton };
