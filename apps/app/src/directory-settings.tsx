import { useState } from "react";

import { Button, Input } from "@ace/ui";
import type { Diagnostics } from "@ace/host/protocol";

import { host } from "./host";
import { Problem, Row, Status } from "./settings-layout";

const SETUP = "https://github.com/githubnext/ace#team-directory";

const secrets = {
	keychain: "Saved in Keychain.",
	environment: "Set in Ace Helper's environment.",
	missing: "Not saved.",
	unavailable: "Keychain access needed.",
};

/** A time today, or a date and time when older, so a stale sync doesn't read as recent. */
function when(time: number) {
	const date = new Date(time);
	return date.toDateString() === new Date().toDateString()
		? date.toLocaleTimeString()
		: date.toLocaleString();
}

/** `row` keeps each result beside the control that caused it. */
type Action = { row?: "directory" | "secret"; busy?: string; error?: string; message?: string };

/** Join, change, or leave the team's directory, and save or remove the team's shared secret. */
export function TeamDirectory(
	{ directory, onChange }: { directory: Diagnostics["directory"]; onChange: () => void },
) {
	const [editing, setEditing] = useState(false);
	const [url, setUrl] = useState("");
	const [secret, setSecret] = useState("");
	const [confirm, setConfirm] = useState<"leave" | "forget">();
	const [action, setAction] = useState<Action>({});
	const saved = directory.secret.source === "keychain" || directory.secret.source === "environment";

	async function run(
		row: Action["row"],
		busy: string,
		message: string,
		request: () => Promise<unknown>,
	) {
		setAction({ row, busy });
		try {
			await request();
			setEditing(false);
			setSecret("");
			setConfirm(undefined);
			setAction({ row, message });
		} catch (error) {
			setAction({ row, error: (error as Error).message });
		}
		onChange();
	}

	function results(row: Action["row"]) {
		if (action.row !== row) return;
		return (
			<>
				{action.busy && <Status>{action.busy}</Status>}
				{action.error && <Problem>{action.error}</Problem>}
				{action.message && <Status>{action.message}</Status>}
			</>
		);
	}

	function close() {
		setEditing(false);
		setSecret("");
	}

	return (
		<>
			<Row
				id="directory-label"
				label="Team directory"
				description={
					<>
						{directory.url
							? `${directory.url} · ${
								directory.synced
									? `Last synced ${when(directory.synced)}.`
									: directory.error
									? "Not synced yet."
									: "Waiting for the first sync…"
							}`
							: "Not configured. Join the directory your team deployed to see everyone's channels, even while their hosts sleep."}
						{" "}
						Deploying a directory is a command-line step for whoever sets up the team;{" "}
						<a
							href={SETUP}
							target="_blank"
							rel="noopener noreferrer"
							className="rounded-sm underline outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
						>
							see how
						</a>.
					</>
				}
				footer={
					<>
						{editing && (
							<form
								className="flex flex-col gap-2"
								onSubmit={(event) => {
									event.preventDefault();
									void run(
										"directory",
										"Checking the directory…",
										"Directory checked and joined.",
										() =>
											host.request({
												op: "directory-set",
												url,
												...(secret.trim() ? { secret } : {}),
											}),
									);
								}}
								onKeyDown={(event) => {
									if (event.key !== "Escape" || action.busy) return;
									// Escape cancels the form before it reaches the dialog.
									event.stopPropagation();
									close();
								}}
							>
								<Input
									autoFocus
									type="url"
									spellCheck={false}
									aria-label="Directory URL"
									placeholder="https://ace-directory.example.workers.dev"
									value={url}
									disabled={!!action.busy}
									onChange={(event) => setUrl(event.target.value)}
								/>
								<Input
									type="password"
									autoComplete="new-password"
									spellCheck={false}
									aria-label="Team secret"
									maxLength={4096}
									placeholder={saved
										? "Team secret (leave blank to keep the saved one)"
										: "Team secret (ACE_SECRET)"}
									value={secret}
									disabled={!!action.busy}
									onChange={(event) => setSecret(event.target.value)}
								/>
								<div className="flex gap-2">
									<Button
										type="submit"
										disabled={!!action.busy || !url.trim() || (!saved && !secret.trim())}
									>
										Check and join
									</Button>
									<Button type="button" variant="ghost" disabled={!!action.busy} onClick={close}>
										Cancel
									</Button>
								</div>
							</form>
						)}
						{confirm === "leave" && (
							<div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3 @md:flex-row @md:items-center @md:justify-between">
								<p>
									Leave the directory? Teammates' channels whose hosts are offline disappear here,
									and this host's channels stop being listed for them.
								</p>
								<div className="flex shrink-0 gap-2">
									<Button
										variant="destructive"
										disabled={!!action.busy}
										onClick={() =>
											void run(
												"directory",
												"Leaving the directory…",
												"Left the directory.",
												() => host.request({ op: "directory-set", url: null }),
											)}
									>
										Leave
									</Button>
									<Button
										variant="ghost"
										disabled={!!action.busy}
										onClick={() => setConfirm(undefined)}
									>
										Cancel
									</Button>
								</div>
							</div>
						)}
						{directory.error && (
							<Problem>
								{directory.failed ? `Sync failed at ${when(directory.failed)}: ` : ""}
								{directory.error}
							</Problem>
						)}
						{results("directory")}
					</>
				}
			>
				{!editing && (
					<Button
						variant="outline"
						disabled={!!action.busy}
						onClick={() => {
							setConfirm(undefined);
							setUrl(directory.url || "");
							setEditing(true);
						}}
					>
						{directory.url ? "Change…" : "Join…"}
					</Button>
				)}
				{directory.url && confirm !== "leave" && (
					<Button
						variant="ghost"
						disabled={!!action.busy}
						onClick={() => {
							close();
							setConfirm("leave");
						}}
					>
						Leave…
					</Button>
				)}
			</Row>
			<Row
				label="Team secret"
				description={
					<>
						{secrets[directory.secret.source]} Hosts use it for the directory and hosted channels.
						{directory.secret.override && (
							<>
								{" "}
								{directory.secret.override}{" "}
								takes priority over a saved secret. Remove it and restart Ace Helper to use
								Keychain.
							</>
						)}
					</>
				}
				footer={
					<>
						{confirm === "forget" && (
							<div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3 @md:flex-row @md:items-center @md:justify-between">
								<p>
									Remove the saved secret? This host can no longer reach the directory or hosted
									channels until you enter it again.
								</p>
								<div className="flex shrink-0 gap-2">
									<Button
										variant="destructive"
										disabled={!!action.busy}
										onClick={() =>
											void run(
												"secret",
												"Removing the secret…",
												"Saved secret removed.",
												() => host.request({ op: "key-forget", name: "ACE_SECRET" }),
											)}
									>
										Remove secret
									</Button>
									<Button
										variant="ghost"
										disabled={!!action.busy}
										onClick={() => setConfirm(undefined)}
									>
										Cancel
									</Button>
								</div>
							</div>
						)}
						{directory.secret.waiting && <Status>{directory.secret.waiting}…</Status>}
						{directory.secret.error && <Problem>{directory.secret.error}</Problem>}
						{results("secret")}
					</>
				}
			>
				{directory.secret.stored && confirm !== "forget" && (
					<Button
						variant="ghost"
						disabled={!!action.busy}
						onClick={() => {
							close();
							setConfirm("forget");
						}}
					>
						Remove…
					</Button>
				)}
			</Row>
		</>
	);
}
