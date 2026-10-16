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
import { githubRepo } from "@ace/host/protocol";

import { here } from "./desktop";
import { useFolder } from "./folder";
import type { AppProject } from "./projects";

/**
 * Clones a project known from other hosts, or a GitHub repository by URL when there is no
 * project, or opens the matching checkout already at the chosen folder. Nothing is cloned until
 * the person confirms the destination.
 */
export function SetupProject({ project, starting, onSetup, onClose }: {
	project?: AppProject & { repo: string };
	starting: boolean;
	onSetup: (repo: string, path: string) => Promise<void>;
	onClose: () => void;
}) {
	const id = useId();
	const { folder } = useFolder();
	const [url, setUrl] = useState("");
	// The folder follows the repository's name until the person edits it.
	const [edited, setEdited] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const repo = project?.repo || url.trim();
	const name = githubRepo(repo)?.split("/")[1];
	// The host expands `~`, so the app never assumes where this machine's home folder is.
	const base = folder?.replace(/\/$/, "");
	const path = edited ?? (base && name ? `${base}/${name}` : "");
	const ready = !!repo && !!path.trim();

	async function setup() {
		if (busy || !ready) return;
		setBusy(true);
		setError("");
		try {
			await onSetup(repo, path.trim());
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
					<DialogTitle>
						{project ? `Set up ${project.label} on ${here}` : "Clone from URL"}
					</DialogTitle>
					<DialogDescription>
						{project
							? `${project.label} is checked out on ${
								[...project.hosts].join(", ")
							}. Clone ${project.repo} into a folder on ${here}${
								starting ? " to start the channel here." : "."
							} `
							: `Clone a GitHub repository into a folder on ${here} and add it as a project. `}
						A checkout of it already in that folder is opened instead.
					</DialogDescription>
				</DialogHeader>
				<form
					id={id}
					onSubmit={(event) => {
						event.preventDefault();
						void setup();
					}}
					className="flex flex-col gap-3"
				>
					{!project && (
						<div>
							<label htmlFor={`${id}-url`} className="mb-1.5 block text-xs font-medium">
								Repository URL
							</label>
							<Input
								id={`${id}-url`}
								autoFocus
								value={url}
								disabled={busy}
								spellCheck={false}
								placeholder="https://github.com/owner/name"
								onChange={(event) => setUrl(event.target.value)}
							/>
						</div>
					)}
					<div>
						<label htmlFor={`${id}-path`} className="mb-1.5 block text-xs font-medium">
							Folder
						</label>
						<Input
							id={`${id}-path`}
							autoFocus={!!project}
							value={path}
							disabled={busy}
							spellCheck={false}
							placeholder={base && `${base}/name`}
							onChange={(event) => setEdited(event.target.value)}
						/>
					</div>
					{error && (
						<p role="alert" className="whitespace-pre-wrap text-xs text-destructive">
							{error}
						</p>
					)}
				</form>
				<DialogFooter>
					<Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
					<Button type="submit" form={id} disabled={busy || !ready}>
						{busy ? "Setting up…" : starting ? "Clone and start channel" : "Clone and open"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
