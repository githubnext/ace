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
	name: string;
	/** Where the channel goes; "local" is this host. */
	target: string;
	label: string;
	onMove: () => void;
	onCancel: () => void;
};

/** A move changes where a channel runs and closes it until the move finishes, so it asks first. */
export function MoveChannel({ name, target, label, onMove, onCancel }: Props) {
	return (
		<Dialog open onOpenChange={next => next || onCancel()}>
			<DialogContent className="gap-3 sm:max-w-80" showCloseButton={false}>
				<DialogHeader>
					<DialogTitle className="break-all">Move #{name} to {label}?</DialogTitle>
					<DialogDescription>
						{target === "local"
							? "The channel runs on this host again."
							: "The channel becomes a hosted channel there, with this host as its workspace."}{" "}
						It keeps its chats, messages, and lanes. Nobody can open it while it moves.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="outline" onClick={onCancel}>
						Cancel
					</Button>
					<Button type="button" onClick={onMove}>
						Move channel
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
