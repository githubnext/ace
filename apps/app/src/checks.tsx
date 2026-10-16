import { useReducer } from "react";

import type { Listing } from "@ace/host/protocol";
import { ChecksNotice } from "@ace/ui";

import { useDetails } from "./details";
import { useGit } from "./git";

// Keyed by the failed runs, so a rerun that fails again shows once more.
const dismissed = new Set<string>();

/** Failed checks on the chat's open pull request, until they pass or someone dismisses them. */
export function Checks({ channel, chat, user }: { channel: Listing; chat: number; user: string }) {
	const { pull } = useDetails(channel.id);
	const { fixChecks } = useGit(channel, chat, user);
	const [, render] = useReducer((count: number) => count + 1, 0);
	if (pull?.state !== "open" && pull?.state !== "draft") return null;
	const failed = pull.checks.filter((check) => check.state === "failed");
	if (!failed.length) return null;
	const key = `${pull.url}\0${failed.map((check) => check.url || check.name).join("\0")}`;
	if (dismissed.has(key)) return null;
	return (
		<ChecksNotice
			pull={pull}
			failed={failed}
			onFix={fixChecks && (() => fixChecks(failed))}
			onDismiss={() => {
				dismissed.add(key);
				render();
			}}
		/>
	);
}
