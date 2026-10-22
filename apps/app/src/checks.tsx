import type { Listing } from "@ace/host/protocol";
import { ChecksNotice, useLocalStorage } from "@ace/ui";

import { useDetails } from "./details";
import { useGit } from "./git";
import { host } from "./host";

/** Failed checks on the chat's open pull request, until they pass or someone dismisses them. */
export function Checks({ channel, chat, user }: { channel: Listing; chat: number; user: string }) {
	const { pull } = useDetails(channel.id);
	const { fixChecks } = useGit(channel, chat, user);
	// Keyed by the failed runs, so a rerun that fails again shows once more; kept across reloads.
	const [dismissed, dismiss] = useLocalStorage<string>(
		`ace:checks-dismissed:${host.url}:${channel.id}`,
		"",
	);
	if (pull?.state !== "open" && pull?.state !== "draft") return null;
	const failed = pull.checks.filter((check) => check.state === "failed");
	if (!failed.length) return null;
	const key = `${pull.url}\0${failed.map((check) => check.url || check.name).join("\0")}`;
	if (dismissed === key) return null;
	return (
		<ChecksNotice
			pull={pull}
			failed={failed}
			onFix={fixChecks && (() => fixChecks(failed))}
			onDismiss={() => dismiss(key)}
		/>
	);
}
