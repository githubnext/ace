import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	toast,
} from "@ace/ui";

import { desktop } from "./desktop";
import { isFocused } from "./focus";
import { host } from "./host";

const CLOCK = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/**
 * Someone on the tailnet asked to join this host's team. Approving sends them the directory URL
 * and team secret; closing leaves the ask to expire.
 */
export function TeamAsks() {
	const asks = useSyncExternalStore(host.subscribe, () => host.asks);
	const [dismissed, setDismissed] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	// The dialog waits in a window the owner may not be looking at; the ask lapses unanswered.
	const told = useRef(new Set<string>());
	useEffect(() => {
		for (const ask of asks) {
			if (told.current.has(ask.id)) continue;
			told.current.add(ask.id);
			if (isFocused()) continue;
			desktop?.notify(
				`Let ${ask.github || ask.login} join your team?`,
				`${ask.login} on ${ask.host} asked. Open Ace to approve or deny.`,
			).catch(() => {});
		}
	}, [asks]);
	const ask = asks.find((value) => !dismissed.includes(value.id));
	if (!ask) return null;
	const who = ask.github || ask.login;

	async function answer(approve: boolean) {
		setBusy(true);
		setError("");
		try {
			await host.request({ op: "team-answer", ask: ask!.id, approve });
			if (approve) {
				toast.success(`Let ${who} in`, {
					description: `${ask!.host} has your team's directory and joins it now.`,
				});
			} else toast(`Declined ${who}'s request`);
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
						over your tailnet. The request lapses at {CLOCK.format(ask.expires)}.
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
