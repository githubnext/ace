import { useState } from "react";

import { Button, Input } from "@ace/ui";
import type { Diagnostics } from "@ace/host/protocol";

import { host } from "./host";
import { useDiagnostics } from "./host-settings";
import { Confirm, Group, Page, Problem, Row, Status, Value } from "./settings-layout";

const SETUP = "https://github.com/githubnext/ace#team-directory";

const secrets = {
	keychain: "Saved in Keychain",
	environment: "From the environment",
	missing: "Not set",
	unavailable: "Keychain access needed",
};

const tailnet = {
	missing: "Not installed",
	offline: "Disconnected",
	running: "Connected",
	error: "Couldn't check",
};

export function TeamSettings({ active }: { active: boolean }) {
	const checks = useDiagnostics(active);
	const checked = checks.value;
	return (
		<Page>
			<Group
				action={
					<Button
						variant="ghost"
						size="sm"
						disabled={!checks.open}
						onClick={() => checks.refresh(true)}
					>
						Refresh
					</Button>
				}
			>
				{checked && (
					<>
						<Row
							label="Tailscale"
							description={checked.tailscale.loopback
								? "Loopback only, so teammates can't reach this host"
								: checked.tailscale.name}
							footer={checked.tailscale.error && <Problem>{checked.tailscale.error}</Problem>}
						>
							<Value>{tailnet[checked.tailscale.state]}</Value>
						</Row>
						<TeamDirectory directory={checked.directory} onChange={() => checks.refresh()} />
					</>
				)}
			</Group>
			{!checks.open
				? <Status>Waiting for Ace Helper…</Status>
				: !checked && !checks.error && <Status>Checking…</Status>}
			{checks.error && checks.open && <Problem>{checks.error}</Problem>}
		</Page>
	);
}

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
function TeamDirectory(
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
				label="Directory"
				description={directory.url || (
					<>
						Not joined.{" "}
						<a
							href={SETUP}
							target="_blank"
							rel="noopener noreferrer"
							className="rounded-sm underline outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
						>
							Set up a directory
						</a>
					</>
				)}
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
										? "Team secret (blank keeps the saved one)"
										: "Team secret"}
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
							<Confirm
								action="Leave"
								busy={!!action.busy}
								onConfirm={() =>
									void run(
										"directory",
										"Leaving the directory…",
										"Left the directory.",
										() => host.request({ op: "directory-set", url: null }),
									)}
								onCancel={() => setConfirm(undefined)}
							>
								Leave the directory? Teammates stop seeing this host's channels while it's offline.
							</Confirm>
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
				{directory.url && (
					<Value>
						{directory.synced
							? `Synced ${when(directory.synced)}`
							: directory.error
							? "Not synced"
							: "Syncing…"}
					</Value>
				)}
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
				description={directory.secret.override
					? `${directory.secret.override} overrides Keychain`
					: secrets[directory.secret.source]}
				footer={
					<>
						{confirm === "forget" && (
							<Confirm
								action="Remove secret"
								busy={!!action.busy}
								onConfirm={() =>
									void run(
										"secret",
										"Removing the secret…",
										"Secret removed.",
										() => host.request({ op: "key-forget", name: "ACE_SECRET" }),
									)}
								onCancel={() => setConfirm(undefined)}
							>
								Remove the team secret? This host loses access to the directory and hosted channels.
							</Confirm>
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
