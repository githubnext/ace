import { useId, useState } from "react";

import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
} from "@ace/ui";

import { here } from "./desktop";
import type { AppProject } from "./projects";

/**
 * Clones a project known from other hosts, or opens the matching checkout already at the chosen
 * folder. Nothing is cloned until the person confirms the destination.
 */
export function SetupProject({ project, starting, onSetup, onClose }: {
	project: AppProject & { repo: string };
	starting: boolean;
	onSetup: (path: string) => Promise<void>;
	onClose: () => void;
}) {
	const id = useId();
	// The host expands `~`, so the app never assumes where this machine's home folder is.
	const [path, setPath] = useState(`~/code/${project.repo.split("/")[1]}`);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function setup() {
		if (busy || !path.trim()) return;
		setBusy(true);
		setError("");
		try {
			await onSetup(path.trim());
		} catch (error) {
			setError((error as Error).message);
			setBusy(false);
		}
	}

	return (
		<Dialog
			open
			onOpenChange={(value) => {
				// The clone keeps running on the host, so the form stays until it reports back.
				if (!value && !busy) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Set up {project.label} on {here}</DialogTitle>
					<DialogDescription>
						{project.label} is checked out on {[...project.hosts].join(", ")}. Clone {project.repo}
						{" "}
						into a folder on {here}
						{starting ? " to start the channel here." : "."}{" "}
						A checkout of it already in that folder is opened instead.
					</DialogDescription>
				</DialogHeader>
				<form
					id={id}
					onSubmit={(event) => {
						event.preventDefault();
						void setup();
					}}
				>
					<label htmlFor={`${id}-path`} className="mb-1.5 block text-xs font-medium">
						Folder
					</label>
					<Input
						id={`${id}-path`}
						autoFocus
						value={path}
						disabled={busy}
						spellCheck={false}
						onChange={(event) => setPath(event.target.value)}
					/>
					{error && (
						<p role="alert" className="mt-2 whitespace-pre-wrap text-xs text-destructive">
							{error}
						</p>
					)}
				</form>
				<DialogFooter>
					<Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
					<Button type="submit" form={id} disabled={busy || !path.trim()}>
						{busy ? "Setting up…" : starting ? "Clone and start channel" : "Clone and open"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
