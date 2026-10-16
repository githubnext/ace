import { useReducer } from "react";

import { ChecksNotice } from "@ace/ui";

import { useDetails } from "./details";

// Keyed by the failed runs, so a rerun that fails again shows once more.
const dismissed = new Set<string>();

/** Failed checks on the chat's open pull request, until they pass or someone dismisses them. */
export function Checks({ channel }: { channel: string }) {
	const { pull } = useDetails(channel);
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
			onDismiss={() => {
				dismissed.add(key);
				render();
			}}
		/>
	);
}
