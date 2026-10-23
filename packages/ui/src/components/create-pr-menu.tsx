import { DropdownMenuItem } from "../ui/dropdown-menu";
import { IconPullRequest } from "../icons";

function CreatePrMenu({ onCreateDraftPr }: { onCreateDraftPr?: () => void }) {
	return (
		<DropdownMenuItem disabled={!onCreateDraftPr} onClick={onCreateDraftPr}>
			<IconPullRequest className="size-4 text-muted-foreground" aria-hidden />
			<span>Create draft PR</span>
		</DropdownMenuItem>
	);
}

export { CreatePrMenu };
