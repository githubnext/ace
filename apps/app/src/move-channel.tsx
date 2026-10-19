import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	type MoveTarget,
} from "@ace/ui";

const OUTCOMES = {
	local: "The channel runs on this host again. It keeps its chats, messages, and lanes.",
	hosted:
		"The channel becomes a hosted channel there, with this host as its workspace. It keeps its chats, messages, and lanes.",
	cloud:
		"Its tools then run in a container on the team's compute service, which starts from a fresh clone with the channel's pushed lanes; untracked files stay on this Mac. It keeps its chats and messages, and can't move back yet.",
};

type Props = {
	name: string;
	place: MoveTarget["place"];
	label: string;
	onMove: () => void;
	onCancel: () => void;
};

/** A move changes where a channel runs and closes it until the move finishes, so it asks first. */
export function MoveChannel({ name, place, label, onMove, onCancel }: Props) {
	return (
		<Dialog open onOpenChange={next => next || onCancel()}>
			<DialogContent className="gap-3 sm:max-w-80" showCloseButton={false}>
				<DialogHeader>
					<DialogTitle className="break-all">Move #{name} to {label}?</DialogTitle>
					<DialogDescription>
						{OUTCOMES[place]} Nobody can open it while it moves.
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
