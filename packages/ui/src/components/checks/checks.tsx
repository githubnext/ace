import type { ComponentType } from "react";

import { IconCircleCheck, IconCircleDashed, IconCircleX, IconLoader, IconX } from "../../icons";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";

export type Check = {
	name: string;
	url?: string;
	state: "pending" | "passed" | "failed" | "skipped";
};

type Icon = ComponentType<{ className?: string }>;

export const CHECK_ICONS: Record<Check["state"], [Icon, string]> = {
	failed: [IconCircleX, "text-destructive"],
	pending: [IconLoader, "animate-spin text-muted-foreground"],
	passed: [IconCircleCheck, "text-success"],
	skipped: [IconCircleDashed, "text-muted-foreground"],
};

const RANK: Record<Check["state"], number> = { failed: 0, pending: 1, passed: 2, skipped: 3 };

/** Failed checks first, then running ones, so what needs attention leads. */
export function sortChecks(checks: Check[]): Check[] {
	return checks.toSorted((a, b) => RANK[a.state] - RANK[b.state]);
}

/** One line for a pull request's checks, or nothing when only skipped checks ran. */
export function checkSummary(checks: Check[]): [Icon, string, string] | undefined {
	const counted = checks.filter((check) => check.state !== "skipped");
	if (!counted.length) return;
	const failed = counted.filter((check) => check.state === "failed").length;
	const pending = counted.filter((check) => check.state === "pending").length;
	if (failed) {
		return [...CHECK_ICONS.failed, `${failed} ${failed === 1 ? "check" : "checks"} failed`];
	}
	if (pending) {
		return [...CHECK_ICONS.pending, `Checks running ${counted.length - pending}/${counted.length}`];
	}
	return [...CHECK_ICONS.passed, "Checks passed"];
}

export type ChecksNoticeProps = {
	pull: { number: number; url: string };
	failed: Check[];
	/** Asks for the failures to be fixed; absent while no one can take that now. */
	onFix?: () => void;
	onDismiss: () => void;
	className?: string;
};

/** A chat's line for failed checks on its pull request, naming each one. */
export function ChecksNotice({ pull, failed, onFix, onDismiss, className }: ChecksNoticeProps) {
	const label = `${failed.length} ${failed.length === 1 ? "check" : "checks"} failed`;
	return (
		<div
			role="status"
			className={cn(
				"mb-2 flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-muted/40 py-1 pr-1 pl-3 text-xs",
				className,
			)}
		>
			<IconCircleX className="size-4 shrink-0 text-destructive" aria-hidden />
			<a
				href={`${pull.url}/checks`}
				target="_blank"
				rel="noopener noreferrer"
				className="shrink-0 font-medium hover:underline"
			>
				{label} on #{pull.number}
			</a>
			<span className="min-w-0 flex-1 truncate text-muted-foreground">
				{failed.map((check, index) => (
					<span key={check.url || check.name}>
						{index > 0 && ", "}
						{check.url
							? (
								<a
									href={check.url}
									target="_blank"
									rel="noopener noreferrer"
									className="hover:text-foreground hover:underline"
								>
									{check.name}
								</a>
							)
							: check.name}
					</span>
				))}
			</span>
			{onFix && (
				<Button type="button" variant="ghost" size="sm" onClick={onFix}>
					Fix
				</Button>
			)}
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				aria-label="Dismiss failed checks"
				onClick={onDismiss}
			>
				<IconX aria-hidden />
			</Button>
		</div>
	);
}
