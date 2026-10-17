import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import { Button, Switch, toast } from "@ace/ui";
import type { UpdateAction, UpdateState } from "@ace/desktop/protocol";

import { desktop } from "./desktop";
import { Group, Page, Problem, Row, Status } from "./settings-layout";

let state: UpdateState | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let polling = false;
const listeners = new Set<() => void>();

function publish(value: UpdateState) {
	if (JSON.stringify(value) === JSON.stringify(state)) return;
	state = value;
	for (const listener of listeners) listener();
}

async function poll() {
	polling = true;
	try {
		if (desktop) publish(await desktop.updates({ op: "status" }));
	} finally {
		polling = false;
		if (listeners.size) timer = setTimeout(() => void poll().catch(() => {}), 1000);
	}
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	if (listeners.size === 1 && !polling) void poll().catch(() => {});
	return () => {
		listeners.delete(listener);
		if (!listeners.size) clearTimeout(timer);
	};
}

function useUpdates() {
	return useSyncExternalStore(subscribe, () => state);
}

export function UpdateNotice({ onOpen }: { onOpen: () => void }) {
	const update = useUpdates();
	const open = useEffectEvent(onOpen);
	useEffect(() => {
		if (update?.phase !== "available") return;
		toast(`Ace ${update.available} is available`, {
			id: "ace-update",
			action: { label: "View update", onClick: () => open() },
			duration: Infinity,
			closeButton: true,
		});
		return () => void toast.dismiss("ace-update");
	}, [update?.phase, update?.available]);
	return null;
}

const labels: Record<UpdateState["phase"], string> = {
	disabled: "Updates are off in development builds",
	idle: "Up to date",
	checking: "Checking…",
	available: "Update ready",
	preparing: "Pausing Ace Helper…",
	downloading: "Downloading…",
	installing: "Installing…",
	restarting: "Restarting…",
	recovering: "Resuming Ace Helper…",
	error: "Update failed",
};

export function UpdateSettings() {
	const update = useUpdates();
	const [error, setError] = useState<string | undefined>(undefined);
	const [acting, setActing] = useState(false);

	async function act(action: UpdateAction) {
		if (!desktop) return;
		setActing(true);
		setError(undefined);
		try {
			publish(await desktop.updates(action));
		} catch (reason) {
			setError((reason as Error).message);
		} finally {
			setActing(false);
		}
	}

	if (!update) return <Status>Loading…</Status>;
	const disabled = update.phase === "disabled";
	const channel = update.channel === "stable"
		? "Stable"
		: update.channel === "canary"
		? "Canary"
		: "Development";
	return (
		<Page>
			<Group>
				<Row
					label={`Ace ${update.version}`}
					description={
						<span role="status">
							{[
								update.phase === "available"
									? `Ace ${update.available} is available`
									: update.phase !== "idle" || update.checked
									? labels[update.phase]
									: undefined,
								channel,
								update.checked && `Checked ${new Date(update.checked).toLocaleString()}`,
							].filter(Boolean).join(" · ")}
						</span>
					}
					footer={
						<>
							{update.phase === "downloading" && (
								<progress
									className="h-1 w-full accent-primary"
									max={1}
									value={update.progress}
									aria-label="Downloading update"
								/>
							)}
							{(error || update.error) && <Problem>{error || update.error}</Problem>}
						</>
					}
				>
					{!disabled && (
						<>
							{update.canCancel && (
								<Button
									variant="ghost"
									disabled={acting}
									onClick={() => void act({ op: "cancel" })}
								>
									Cancel
								</Button>
							)}
							{update.needsRecovery
								? (
									<Button disabled={acting} onClick={() => void act({ op: "recover" })}>
										Resume Ace Helper
									</Button>
								)
								: update.phase === "available"
								? (
									<Button disabled={acting} onClick={() => void act({ op: "install" })}>
										Install and Restart
									</Button>
								)
								: (
									<Button
										variant="outline"
										disabled={acting || !["idle", "error"].includes(update.phase)}
										onClick={() => void act({ op: "check" })}
									>
										Check for Updates
									</Button>
								)}
						</>
					)}
				</Row>
				{!disabled && (
					<Row
						id="automatic-updates-label"
						label="Check automatically"
					>
						<Switch
							aria-labelledby="automatic-updates-label"
							checked={update.automatic}
							disabled={acting || update.needsRecovery}
							onCheckedChange={(value) => void act({ op: "automatic", value })}
						/>
					</Row>
				)}
			</Group>
		</Page>
	);
}
