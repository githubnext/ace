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
import { IconArrowDownToLine, IconBranch, IconFolderSearch } from "@ace/ui/icons";

import { desktop } from "./desktop";

export function EmptyProjects({ onOpen, onClone, disabled }: {
	onOpen: () => void;
	onClone: () => void;
	disabled: boolean;
}) {
	return (
		<div className="mx-auto flex min-h-full w-full max-w-[42rem] flex-col justify-center px-5 py-10">
			<div className="flex flex-col items-center gap-5 text-center">
				<div className="grid size-10 place-items-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground">
					<IconFolderSearch className="size-5" aria-hidden />
				</div>
				<div className="flex flex-col gap-2">
					<h1 className="text-xl font-medium tracking-normal">Open a project</h1>
					<p className="text-sm leading-6 text-muted-foreground">
						Choose a folder or clone a GitHub repository to get started.
					</p>
				</div>
				<div className="flex flex-wrap justify-center gap-2">
					<Button onClick={onOpen} disabled={disabled}>
						<IconFolderSearch aria-hidden data-icon="inline-start" />
						Open folder…
						{desktop && <kbd className="ml-2 text-xs opacity-60">⌘O</kbd>}
					</Button>
					<Button variant="outline" onClick={onClone} disabled={disabled}>
						<IconArrowDownToLine aria-hidden data-icon="inline-start" />
						Clone from URL…
					</Button>
				</div>
			</div>
		</div>
	);
}

/** Lanes are Git worktrees, so a folder needs a commit before it can start channels. */
export function InitGit({ name, disabled, onInit }: {
	name: string;
	disabled: boolean;
	onInit: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);

	async function init() {
		setBusy(true);
		try {
			await onInit();
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex w-full flex-col items-center gap-3 rounded-lg border border-border/70 bg-muted/30 px-5 py-6 text-center">
			<IconBranch className="size-5 text-muted-foreground" aria-hidden />
			<h2 className="text-sm font-medium">Initialize a Git repository to get started</h2>
			<p className="max-w-[30rem] text-pretty text-xs leading-5 text-muted-foreground">
				Channels work in lanes, which are Git worktrees. Ace will run <code>git init</code> in{" "}
				{name}, add a <code>.gitignore</code> that leaves out secrets such as{" "}
				<code>.env</code>, dependencies, and build output, and commit the rest.
			</p>
			<Button
				disabled={disabled || busy}
				onClick={() => void init()}
			>
				{busy ? "Initializing…" : "Initialize Git"}
			</Button>
		</div>
	);
}

/** Browsers cannot pick a host directory; the desktop uses the native folder dialog. */
export function OpenProject({ onOpen, onClose }: {
	onOpen: (path: string) => Promise<void>;
	onClose: () => void;
}) {
	const id = useId();
	const [path, setPath] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function open() {
		if (busy || !path.trim()) return;
		setBusy(true);
		setError("");
		try {
			await onOpen(path.trim());
			onClose();
		} catch (error) {
			setError((error as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog
			open
			onOpenChange={(value) => {
				if (!value) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Open a folder</DialogTitle>
					<DialogDescription>Enter the folder’s path on this host.</DialogDescription>
				</DialogHeader>
				<form
					id={id}
					onSubmit={(event) => {
						event.preventDefault();
						void open();
					}}
				>
					<Input
						autoFocus
						aria-label="Project folder"
						placeholder="~/code/project"
						value={path}
						disabled={busy}
						onChange={(event) => setPath(event.target.value)}
					/>
					{error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
				</form>
				<DialogFooter>
					<Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
					<Button type="submit" form={id} disabled={busy || !path.trim()}>
						{busy ? "Opening…" : "Open folder"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
