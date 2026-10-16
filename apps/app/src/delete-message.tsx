import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ace/ui";

type Props = {
	onDelete: () => void;
	onCancel: () => void;
};

/** Deleting can't be undone, and agents that already read the message keep what they read. */
export function DeleteMessage({ onDelete, onCancel }: Props) {
	return (
		<Dialog open onOpenChange={(next) => next || onCancel()}>
			<DialogContent className="gap-3 sm:max-w-80" showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>Delete message?</DialogTitle>
					<DialogDescription>
						Everyone in the channel sees that it was deleted. Agents won't read it again, but runs
						that already read it keep what they learned.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="outline" onClick={onCancel}>
						Cancel
					</Button>
					<Button type="button" variant="destructive" onClick={onDelete}>
						Delete message
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
