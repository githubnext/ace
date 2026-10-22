import { useId, useState } from "react";

import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ace/ui";

/**
 * Removing only forgets the folder, so a person may turn the question off. The host refuses while
 * the project has channels, so then this says how to delete them instead of offering to remove.
 */
export function RemoveProject({ name, path, channels, onRemove, onCancel }: {
	name: string;
	path: string;
	/** This host's channels in it, counting archived ones. */
	channels: number;
	onRemove: (ask: boolean) => Promise<void>;
	onCancel: () => void;
}) {
	const id = useId();
	const [busy, setBusy] = useState(false);
	const [skip, setSkip] = useState(false);

	async function confirm() {
		setBusy(true);
		try {
			await onRemove(!skip);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open onOpenChange={next => (next || busy ? undefined : onCancel())}>
			<DialogContent className="gap-3 sm:max-w-80" showCloseButton={false}>
				<DialogHeader>
					<DialogTitle className="break-all">
						{channels
							? `${name} still has ${channels === 1 ? "a channel" : "channels"}`
							: `Remove ${name}?`}
					</DialogTitle>
					<DialogDescription className="break-words">
						{channels
							? `It has ${
								channels === 1 ? "a channel" : `${channels} channels`
							}, counting archived ones. Archive ${
								channels === 1 ? "it" : "each"
							} from its ⋯ menu, delete it from the Archived group, then remove the project.`
							: `Ace forgets the project. Its files and lanes stay in ${path}, and opening the folder adds it back.`}
					</DialogDescription>
				</DialogHeader>
				{channels > 0
					? (
						<DialogFooter>
							<Button type="button" variant="outline" onClick={onCancel}>OK</Button>
						</DialogFooter>
					)
					: (
						<>
							<label htmlFor={id} className="flex items-center gap-2 text-xs text-muted-foreground">
								<input
									id={id}
									type="checkbox"
									checked={skip}
									disabled={busy}
									onChange={(event) => setSkip(event.target.checked)}
								/>
								Don't ask again
							</label>
							<DialogFooter>
								<Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
									Cancel
								</Button>
								<Button
									type="button"
									variant="destructive"
									disabled={busy}
									onClick={() => void confirm()}
								>
									{busy ? "Removing…" : "Remove project"}
								</Button>
							</DialogFooter>
						</>
					)}
			</DialogContent>
		</Dialog>
	);
}
