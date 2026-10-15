import { useState } from "react";

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
	onDelete: () => Promise<void>;
	onCancel: () => void;
};

/** Deleting removes the channel's data for good (docs/data.md), so it always asks first. */
export function DeleteChannel({ name, onDelete, onCancel }: Props) {
	const [busy, setBusy] = useState(false);

	async function confirm() {
		setBusy(true);
		try {
			await onDelete();
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open onOpenChange={next => (next || busy ? undefined : onCancel())}>
			<DialogContent className="gap-3 sm:max-w-80" showCloseButton={false}>
				<DialogHeader>
					<DialogTitle className="break-all">Delete #{name}?</DialogTitle>
					<DialogDescription>
						This permanently removes the channel's messages, runs, chats, and tool results. Run{" "}
						<code>ace backup</code> first to keep a copy.
					</DialogDescription>
				</DialogHeader>
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
						{busy ? "Deleting…" : "Delete channel"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
