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
	/** Commands in progress in the channel's terminals. */
	commands: string[];
	onArchive: () => void;
	onCancel: () => void;
};

/** Archiving hangs up the channel's terminals, so it asks first while one is running a command. */
export function ArchiveChannel({ name, commands, onArchive, onCancel }: Props) {
	const list = [...new Set(commands)].join(", ");
	const count = commands.length === 1 ? "A terminal is" : `${commands.length} terminals are`;
	return (
		<Dialog open onOpenChange={next => next || onCancel()}>
			<DialogContent className="gap-3 sm:max-w-80" showCloseButton={false}>
				<DialogHeader>
					<DialogTitle className="break-all">Archive #{name}?</DialogTitle>
					<DialogDescription>
						{count} still running <code>{list}</code>. Archiving ends {commands.length === 1
							? "it"
							: "them"}.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="outline" onClick={onCancel}>
						Cancel
					</Button>
					<Button type="button" variant="destructive" onClick={onArchive}>
						Archive channel
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
