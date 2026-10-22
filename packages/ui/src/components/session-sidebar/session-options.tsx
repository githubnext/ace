import { Button } from "../../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { IconDots } from "../../icons";

/**
 * Additional ways to start a repository session, archiving inactive channels, and sharing or
 * removing the project: the section's context menu, plus the starts.
 */
export function SessionOptions(
	{ className, onContinuePr, onStartIssue, onArchiveInactive, onShareProject, onRemoveProject }: {
		className?: string;
		onContinuePr?: () => void;
		onStartIssue?: () => void;
		onArchiveInactive?: () => void;
		onShareProject?: () => void;
		onRemoveProject?: () => void;
	},
) {
	if (
		!onContinuePr && !onStartIssue && !onArchiveInactive && !onShareProject && !onRemoveProject
	) return null;
	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger
					render={
						<DropdownMenuTrigger
							render={
								<Button
									size="icon-sm"
									variant="ghost"
									className={className}
									aria-label="More options"
								>
									<IconDots className="size-3.5" />
								</Button>
							}
						/>
					}
				/>
				<TooltipContent side="right">More options</TooltipContent>
			</Tooltip>
			<DropdownMenuContent side="right" align="start" className="inline-52">
				{onContinuePr && (
					<DropdownMenuItem onClick={onContinuePr}>Continue a pull request…</DropdownMenuItem>
				)}
				{onStartIssue && (
					<DropdownMenuItem onClick={onStartIssue}>Start from an issue…</DropdownMenuItem>
				)}
				{onArchiveInactive && (
					<DropdownMenuItem onClick={onArchiveInactive}>Archive inactive</DropdownMenuItem>
				)}
				{onShareProject && (
					<DropdownMenuItem onClick={onShareProject}>Share project…</DropdownMenuItem>
				)}
				{onRemoveProject && (
					<DropdownMenuItem onClick={onRemoveProject}>Remove project…</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
