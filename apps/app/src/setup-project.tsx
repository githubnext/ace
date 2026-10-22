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
import { githubRepo, NOT_GITHUB, type Project } from "@ace/host/protocol";

import { desktop, here } from "./desktop";
import { useFolder } from "./folder";
import type { AppProject } from "./projects";

/**
 * Clones a project that isn't on this machine yet, or a GitHub repository by URL when there is no
 * project, or opens the matching checkout already at the chosen folder. Nothing is cloned until
 * the person confirms the destination.
 */
export function SetupProject({ project, opened, starting, onSetup, onClose }: {
	project?: AppProject & { repo: string };
	/** This host's projects, to say when a cloned repository already is one. */
	opened: Project[];
	starting: boolean;
	onSetup: (repo: string, path: string) => Promise<void>;
	onClose: () => void;
}) {
	const id = useId();
	const { folder } = useFolder();
	const [url, setUrl] = useState("");
	// A picked folder holds the clone; the clone's own folder still follows the repository's name.
	const [parent, setParent] = useState<string>();
	// The folder follows the repository's name until the person edits it.
	const [edited, setEdited] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const repo = project?.repo || url.trim();
	const full = githubRepo(repo);
	const name = full?.split("/")[1];
	const existing = !project && full
		&& opened.find((value) => value.repo?.toLowerCase() === full.toLowerCase());
	// The host expands `~`, so the app never assumes where this machine's home folder is.
	const base = (parent ?? folder)?.replace(/\/$/, "");
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

	async function choose() {
		if (!desktop) return;
		try {
			const chosen = await desktop.project();
			if (!chosen) return;
			setParent(chosen);
			setEdited(undefined);
			setError("");
		} catch (error) {
			setError((error as Error).message);
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
							? `${project.label} isn't on ${here} yet. Clone ${project.repo} from GitHub to get a copy here${
								starting ? ", then start the channel." : "."
							}`
							: `Clone a GitHub repository to ${here} and add it as a project.`}
					</DialogDescription>
				</DialogHeader>
				<form
					id={id}
					onSubmit={(event) => {
						event.preventDefault();
						void setup();
					}}
					className="flex min-w-0 flex-col gap-3"
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
								onChange={(event) => {
									setUrl(event.target.value);
									setError("");
								}}
							/>
							{url.trim() && !full && (
								<p className="mt-1.5 text-xs text-muted-foreground">{NOT_GITHUB}</p>
							)}
							{existing && (
								<p className="mt-1.5 text-xs text-muted-foreground wrap-anywhere">
									{full} is already a project at{" "}
									{existing.path}. Another copy won't add a second project.
								</p>
							)}
						</div>
					)}
					<div>
						<label htmlFor={`${id}-path`} className="mb-1.5 block text-xs font-medium">
							Folder
						</label>
						<div className="flex gap-2">
							<Input
								id={`${id}-path`}
								value={path}
								disabled={busy}
								spellCheck={false}
								placeholder={base && `${base}/name`}
								onChange={(event) => {
									setEdited(event.target.value);
									setError("");
								}}
							/>
							{desktop && (
								<Button
									type="button"
									variant="outline"
									disabled={busy}
									onClick={() => void choose()}
								>
									Choose another folder…
								</Button>
							)}
						</div>
					</div>
					{error && (
						<p role="alert" className="whitespace-pre-wrap text-xs text-destructive wrap-anywhere">
							{error}
						</p>
					)}
				</form>
				<DialogFooter className="min-w-0">
					<Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
					<Button
						type="submit"
						form={id}
						autoFocus={!!project}
						disabled={busy || !ready}
						className="min-w-0 shrink"
					>
						<span className="truncate">
							{busy ? "Setting up…" : ready ? `Clone to ${path.trim()}` : "Clone"}
						</span>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
