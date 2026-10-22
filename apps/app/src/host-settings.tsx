import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@ace/ui";
import { IconCheck, IconCopy } from "@ace/ui/icons";
import type { HelperAction, HelperState } from "@ace/desktop/protocol";
import type { Diagnostics } from "@ace/host/protocol";

import { CommandLine } from "./command-settings";
import { desktop } from "./desktop";
import { host } from "./host";
import { Qr } from "./qr";
import { Confirm, Group, Page, Problem, Row, Status, Value } from "./settings-layout";

/** The host's tool and team checks, re-read while `active` and whenever `refresh` is called. */
export function useDiagnostics(active: boolean) {
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const [retry, setRetry] = useState(0);
	/** A refresh can also sync the team directory, so its row shows that attempt rather than a stale one. */
	const syncing = useRef(false);
	const [checks, setChecks] = useState<{ value?: Diagnostics; error?: string }>({});

	useEffect(() => {
		if (!active || status !== "open") return;
		let live = true;
		const sync = syncing.current;
		syncing.current = false;
		host.request<Diagnostics>({ op: "diagnostics", ...(sync ? { sync } : {}) }).then(
			(value) => {
				if (live) setChecks({ value });
			},
			(error: Error) => {
				if (live) setChecks({ error: error.message });
			},
		);
		return () => {
			live = false;
		};
	}, [active, status, retry]);

	// The shell environment, the first directory sync, and a keychain read waiting on a prompt all
	// land in the background; show their results without a manual refresh.
	useEffect(() => {
		const value = checks.value;
		if (!active || !value) return;
		const { directory, shell } = value;
		const pending = shell.state === "pending"
			|| directory.secret.waiting
			|| (directory.url && !directory.synced && !directory.failed);
		if (!pending) return;
		const timer = setTimeout(() => setRetry((value) => value + 1), 3000);
		return () => clearTimeout(timer);
	}, [active, checks]);

	return {
		open: status === "open",
		...checks,
		refresh(sync?: boolean) {
			syncing.current = !!sync;
			setRetry((value) => value + 1);
		},
	};
}

function describe(helper?: HelperState) {
	if (!helper) return "Checking…";
	if (helper.running && !helper.managed) {
		return "Run by ace serve. Stop it to manage Ace Helper here.";
	}
	if (helper.running) return "Running. Starts at login.";
	if (helper.unresponsive) return "Not responding yet";
	if (helper.service === "approval") return "Needs approval in Login Items";
	return "Stopped";
}

const busy: Partial<Record<HelperAction, string>> = {
	start: "Starting Ace Helper…",
	restart: "Restarting Ace Helper…",
	stop: "Stopping Ace Helper…",
};

export function HostStatus({ active }: { active: boolean }) {
	const checks = useDiagnostics(active);
	const [tick, setTick] = useState(0);
	const [helper, setHelper] = useState<{ value?: HelperState; error?: string }>({});
	const [action, setAction] = useState<{ busy?: HelperAction; error?: string }>({});
	const [confirm, setConfirm] = useState(false);

	useEffect(() => {
		if (!active || !desktop) return;
		let live = true;
		desktop.helper("status").then(
			(value) => {
				if (live) setHelper({ value });
			},
			(error: Error) => {
				if (live) setHelper({ error: error.message });
			},
		);
		return () => {
			live = false;
		};
	}, [active, tick]);

	useEffect(() => {
		if (!active || !helper.value?.unresponsive) return;
		const timer = setTimeout(() => setTick((value) => value + 1), 2000);
		return () => clearTimeout(timer);
	}, [active, helper]);

	async function control(command: HelperAction) {
		if (!desktop) return;
		setAction({ busy: command });
		setConfirm(false);
		try {
			setHelper({ value: await desktop.helper(command) });
			setAction({});
			checks.refresh();
		} catch (error) {
			setAction({ error: (error as Error).message });
		}
	}

	const current = helper.value;
	const terminal = current?.running && !current.managed;
	const available = !!current && !terminal && !action.busy;
	const checked = checks.value;

	return (
		<Page>
			{desktop && (
				<Group>
					<Row
						label="Status"
						description={<span role="status">{describe(current)}</span>}
						footer={
							<>
								{confirm && (
									<Confirm
										action="Stop"
										onConfirm={() => void control("stop")}
										onCancel={() => setConfirm(false)}
									>
										Channels on this Mac go offline until you start Ace Helper again.
									</Confirm>
								)}
								{action.busy && busy[action.busy] && <Status>{busy[action.busy]}</Status>}
								{(action.error || helper.error) && (
									<Problem>{action.error || helper.error}</Problem>
								)}
							</>
						}
					>
						{current?.service === "approval" && !current.running && (
							<Button
								variant="outline"
								disabled={!!action.busy}
								onClick={() => void control("settings")}
							>
								Open Login Items
							</Button>
						)}
						{!current?.running && !current?.unresponsive
							? (
								<Button disabled={!available} onClick={() => void control("start")}>
									Start
								</Button>
							)
							: (
								<>
									{current?.running && (
										<Button
											variant="outline"
											disabled={!available}
											onClick={() => void control("restart")}
										>
											Restart
										</Button>
									)}
									<Button
										variant="outline"
										disabled={!available || confirm}
										onClick={() => setConfirm(true)}
									>
										Stop…
									</Button>
								</>
							)}
					</Row>
					<Row label="Log">
						<Button
							variant="outline"
							disabled={!!action.busy}
							onClick={() => void control("log")}
						>
							Show
						</Button>
					</Row>
					<CommandLine active={active} />
				</Group>
			)}
			{checked?.tailscale.state === "running" && !checked.tailscale.loopback && (
				<Group title="Phone">
					<Phone web={checked.web} http={checked.http} />
				</Group>
			)}
			<Group
				title="Tools"
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
							label="Shell environment"
							description={checked.shell.state === "adopted"
								? undefined
								: checked.shell.state === "pending"
								? "Using a minimal PATH until your login shell loads"
								: "Using a minimal PATH. Restart Ace Helper to retry."}
							footer={checked.shell.error && <Problem>{checked.shell.error}</Problem>}
						>
							<Value>
								{checked.shell.state === "adopted"
									? "Login shell"
									: checked.shell.state === "pending"
									? "Loading…"
									: "Not loaded"}
							</Value>
						</Row>
						{checked.tools.map((tool) => (
							<Row
								key={tool.name}
								label={tool.name}
								description={tool.path}
								footer={tool.error && <Problem>{tool.error}</Problem>}
							>
								{(tool.version || !tool.path) && <Value>{tool.version || "Not found"}</Value>}
							</Row>
						))}
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

/**
 * The address the owner's phone opens over the tailnet: HTTPS when the tailnet has certificates,
 * else plain HTTP, which works except for the microphone.
 */
function Phone({ web: secure, http }: { web?: string; http?: string }) {
	const [copied, setCopied] = useState(false);
	const web = secure || http;
	if (!web) {
		return (
			<Row
				label="Open on your phone"
				description="Turn on HTTPS in the Tailscale admin console's DNS settings, then restart Ace Helper."
			/>
		);
	}
	return (
		<Row
			label="Open on your phone"
			description={secure
				? "Scan with a phone on your tailnet."
				: "Scan with a phone on your tailnet. Browsers keep the microphone off over HTTP; for voice input, turn on HTTPS in the Tailscale admin console's DNS settings, then restart Ace Helper."}
			footer={
				<div className="flex flex-wrap items-center gap-4">
					<Qr value={web} label={`QR code for ${web}`} className="size-36 rounded-md" />
					<div className="flex min-w-0 items-center gap-1">
						<code className="truncate text-xs text-muted-foreground">{web}</code>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Copy address"
							onClick={() => {
								void navigator.clipboard.writeText(web).then(() => setCopied(true));
							}}
						>
							{copied ? <IconCheck /> : <IconCopy />}
						</Button>
					</div>
				</div>
			}
		/>
	);
}
