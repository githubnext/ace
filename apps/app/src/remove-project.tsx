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

/** Removing only forgets the folder, so a person may turn the question off. */
export function RemoveProject({ name, path, onRemove, onCancel }: {
	name: string;
	path: string;
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
					<DialogTitle className="break-all">Remove {name}?</DialogTitle>
					<DialogDescription className="break-words">
						Ace forgets the project. Its files and lanes stay in{" "}
						{path}, and opening the folder adds it back.
					</DialogDescription>
				</DialogHeader>
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
			</DialogContent>
		</Dialog>
	);
}
