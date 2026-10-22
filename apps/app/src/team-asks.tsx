import { useState, useSyncExternalStore } from "react";

import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ace/ui";

import { host } from "./host";

/**
 * Someone on the tailnet asked to join this host's team. Approving sends them the directory URL
 * and team secret; closing leaves the ask to expire.
 */
export function TeamAsks() {
	const asks = useSyncExternalStore(host.subscribe, () => host.asks);
	const [dismissed, setDismissed] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const ask = asks.find((value) => !dismissed.includes(value.id));
	if (!ask) return null;
	const who = ask.github || ask.login;

	async function answer(approve: boolean) {
		setBusy(true);
		setError("");
		try {
			await host.request({ op: "team-answer", ask: ask!.id, approve });
		} catch (error) {
			setError((error as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open onOpenChange={(next) => next || setDismissed([...dismissed, ask.id])}>
			<DialogContent className="gap-4 sm:max-w-[28rem]">
				<DialogHeader>
					<DialogTitle>Let {who} join your team?</DialogTitle>
					<DialogDescription>
						{ask.login} on {ask.host}{" "}
						asked from Ace. Approving sends this host's directory URL and team secret to {ask.host}
						{" "}
						over your tailnet.
					</DialogDescription>
				</DialogHeader>
				{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
				<DialogFooter>
					<Button variant="ghost" disabled={busy} onClick={() => void answer(false)}>
						Deny
					</Button>
					<Button disabled={busy} onClick={() => void answer(true)}>Approve</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
