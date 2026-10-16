import { DropdownMenuItem } from "../ui/dropdown-menu";
import { IconExternal, IconPullRequest } from "../icons";

type CreatePrMenuProps = {
	onCreateDraftPr?: () => void;
	onManualCreatePr?: () => void;
};

function CreatePrMenu({ onCreateDraftPr, onManualCreatePr }: CreatePrMenuProps) {
	return (
		<>
			<DropdownMenuItem disabled={!onCreateDraftPr} onClick={onCreateDraftPr}>
				<IconPullRequest className="size-4 text-muted-foreground" aria-hidden />
				<span>Create draft PR</span>
			</DropdownMenuItem>
			{onManualCreatePr && (
				<DropdownMenuItem onClick={onManualCreatePr}>
					<IconExternal className="size-4.5 text-muted-foreground" aria-hidden />
					<span>Manually create PR</span>
				</DropdownMenuItem>
			)}
		</>
	);
}

export { CreatePrMenu };
