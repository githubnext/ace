import { useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "@ace/ui";
import type { HelperAction, HelperState } from "@ace/desktop/protocol";
import type { Diagnostics } from "@ace/host/protocol";

import { desktop } from "./desktop";
import { host } from "./host";
import { Disclosure, Group, Problem, Row, Status } from "./settings-layout";

const tailnet = {
	missing: "Tailscale is not installed",
	offline: "Tailscale is disconnected",
	running: "Tailscale is connected",
	error: "Tailscale could not be checked",
};

export function HostStatus({ active }: { active: boolean }) {
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const [retry, setRetry] = useState(0);
	const [checks, setChecks] = useState<{ value?: Diagnostics; error?: string }>({});
	const [helper, setHelper] = useState<{ value?: HelperState; error?: string }>({});
	const [action, setAction] = useState<{ busy?: HelperAction; error?: string }>({});
	const [confirm, setConfirm] = useState(false);

	// Re-read when the section is shown again; results from an action in flight still land here.
	useEffect(() => {
		if (!active) return;
		let live = true;
		if (desktop) {
			desktop.helper("status").then(
				(value) => {
					if (live) setHelper({ value });
				},
				(error: Error) => {
					if (live) setHelper({ error: error.message });
				},
			);
		}
		if (status === "open") {
			host.request<Diagnostics>({ op: "diagnostics" }).then(
				(value) => {
					if (live) setChecks({ value });
				},
				(error: Error) => {
					if (live) setChecks({ error: error.message });
				},
			);
		}
		return () => {
			live = false;
		};
	}, [active, status, retry]);

	// The helper retries loading its shell environment in the background; clear the warning once it does.
	useEffect(() => {
		if (!active || checks.value?.shell.state !== "pending") return;
		const timer = setTimeout(() => setRetry((value) => value + 1), 5000);
		return () => clearTimeout(timer);
	}, [active, checks]);

	useEffect(() => {
		if (!active || !helper.value?.unresponsive) return;
		const timer = setTimeout(() => setRetry((value) => value + 1), 2000);
		return () => clearTimeout(timer);
	}, [active, helper]);

	async function control(command: HelperAction) {
		if (!desktop) return;
		setAction({ busy: command });
		setConfirm(false);
		try {
			setHelper({ value: await desktop.helper(command) });
			setAction({});
			setRetry((value) => value + 1);
		} catch (error) {
			setAction({ error: (error as Error).message });
		}
	}

	const current = helper.value;
	const terminal = current?.running && !current.managed;
	const available = !!current && !terminal && !action.busy;
	const checked = checks.value;

	return (
		<div className="flex flex-col gap-6">
			{desktop && (
				<Group>
					<Row
						label="Ace Helper"
						description={
							<span role="status">
								{terminal
									? "Using a command-line host. Stop ace serve before managing Ace Helper here."
									: current?.running
									? "Running in the background. It starts at login and keeps channels available after you quit Ace."
									: current?.unresponsive
									? "Running, but not responding yet. Ace keeps checking; channels on this Mac wait until it answers."
									: current?.service === "approval"
									? "macOS approval required. Allow Ace in Login Items to run Ace Helper in the background."
									: current
									? "Stopped. Ace Helper starts at login and keeps channels available after you quit Ace."
									: "Checking Ace Helper…"}
							</span>
						}
						footer={
							<>
								{confirm && (
									<div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3 @md:flex-row @md:items-center @md:justify-between">
										<p>
											This host's channels and tools will go offline. Work resumes when you start
											Ace Helper. Background hosting will stay off until you enable it again.
										</p>
										<div className="flex shrink-0 gap-2">
											<Button variant="destructive" onClick={() => void control("stop")}>
												Stop Ace Helper
											</Button>
											<Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
										</div>
									</div>
								)}
								{action.busy && <Status>Updating Ace Helper…</Status>}
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
				</Group>
			)}
			{status !== "open"
				? <Status>Connect to Ace Helper to check tools and team connectivity.</Status>
				: checked
				? (
					<>
						<Group title="Team">
							<Row
								label="Tailscale"
								description={`${tailnet[checked.tailscale.state]}${
									checked.tailscale.name ? ` as ${checked.tailscale.name}` : ""
								}. Teammates reach this host over Tailscale; restart Ace Helper after connecting or changing it.`}
								footer={checked.tailscale.error && <Problem>{checked.tailscale.error}</Problem>}
							/>
							<Row
								label="Team directory"
								description={checked.directory.url
									? checked.directory.synced
										? `Last synced ${new Date(checked.directory.synced).toLocaleTimeString()}`
										: "Waiting for the first sync…"
									: "Not configured"}
								footer={checked.directory.error && <Problem>{checked.directory.error}</Problem>}
							/>
						</Group>
						<Group title="Tools">
							<Row
								label="Shell environment"
								description={checked.shell.state === "adopted"
									? "Tools resolve from your login shell's PATH."
									: checked.shell.state === "pending"
									? "Not loaded yet, so tools resolve from a minimal PATH and may be reported missing. Ace Helper keeps retrying in the background."
									: "Not loaded, so tools resolve from a minimal PATH and may be reported missing. Restart Ace Helper to try again."}
								footer={checked.shell.error && <Problem>{checked.shell.error}</Problem>}
							>
								<span className="text-xs text-muted-foreground">
									{checked.shell.state === "adopted" ? "Loaded" : "Needs attention"}
								</span>
							</Row>
							{checked.tools.map((tool) => (
								<Row
									key={tool.name}
									label={tool.name}
									footer={tool.error && <Problem>{tool.error}</Problem>}
								>
									<span className="text-xs text-muted-foreground">
										{tool.error ? "Needs attention" : "Available"}
									</span>
								</Row>
							))}
						</Group>
					</>
				)
				: !checks.error && <Status>Checking this host…</Status>}
			{checks.error && status === "open" && <Problem>{checks.error}</Problem>}
			<Disclosure summary="Troubleshooting">
				{checked && (
					<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
						{checked.tools.map((tool) => (
							<div key={tool.name} className="contents">
								<dt className="text-muted-foreground">{tool.name}</dt>
								<dd className="break-all">
									{[tool.version, tool.path].filter(Boolean).join(" · ") || "Not found"}
								</dd>
							</div>
						))}
						<dt className="text-muted-foreground">Directory</dt>
						<dd className="break-all">{checked.directory.url || "Not configured"}</dd>
					</dl>
				)}
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						disabled={!!action.busy}
						onClick={() => setRetry((value) => value + 1)}
					>
						Refresh status
					</Button>
					{desktop && (
						<>
							<Button
								variant="outline"
								disabled={!!action.busy}
								onClick={() => void control("log")}
							>
								Show helper log
							</Button>
							<Button
								variant="outline"
								disabled={!!action.busy}
								onClick={() => void control("settings")}
							>
								macOS Login Items
							</Button>
						</>
					)}
				</div>
			</Disclosure>
		</div>
	);
}
