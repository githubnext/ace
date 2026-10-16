import { useEffect, useRef } from "react";

import type { GithubCheck, GithubPull } from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";
import { toast } from "@ace/ui";

import { publish, useDetails } from "./details";
import { host } from "./host";

function create(draft: boolean) {
	return `Open a ${
		draft ? "draft " : ""
	}pull request for this lane's work: commit what belongs in it, then land it with \`lane push\` and \`gh pr create${
		draft ? " --draft" : ""
	}\`, following this repository's instructions and pull request template.`;
}

function fix(pull: GithubPull, failed: GithubCheck[]) {
	const names = failed.map((check) => check.name).join(", ");
	return `Checks failed on #${pull.number}: ${names}. Find the cause in their logs, fix it in this lane, and push the fix with \`lane push\`.`;
}

/**
 * Git and pull request actions for a chat's lane. Each one asks the chat's agent, which works in
 * the lane and lands it through lane, so a click never pushes past `lane push` or the repository's
 * own pull request instructions. They're offered only while the agent could take the request now.
 */
export function useGit(channel: Listing, chat: number, user: string) {
	const { info, changes, pull, shared, creating } = useDetails(channel.id);
	const busy = !!info?.chats.find((value) => value.id === chat)?.busy;
	const ready = !!info && !busy && (shared !== false || channel.owner === user);
	const changed = !!changes && (changes.files.length > 0 || !!changes.dirs);

	function ask(text: string) {
		return host.channel(channel.id, { op: "ask", chat, author: user, text }).catch(
			(error: Error) => {
				toast.error("Could not invoke agent", { description: error.message });
				throw error;
			},
		);
	}

	function createPr(draft: boolean) {
		publish(channel.id, { creating: true });
		ask(create(draft)).catch(() => publish(channel.id, { creating: false }));
	}

	const open = ready && changed && pull === null && !creating;
	return {
		creatingPr: !!creating,
		createPr: open ? () => createPr(false) : undefined,
		createDraftPr: open ? () => createPr(true) : undefined,
		fixChecks: ready && pull
			? (failed: GithubCheck[]) => void ask(fix(pull, failed)).catch(() => {})
			: undefined,
	};
}

/**
 * Ends Create PR's pending state once the pull request exists or the run it started ends. Called
 * once per shown channel, by its details, which stay mounted while the channel is shown.
 */
export function useCreating(channel: string, busy: boolean, pull: GithubPull | null | undefined) {
	const { creating } = useDetails(channel);
	const ran = useRef(false);
	useEffect(() => {
		if (!creating) {
			ran.current = false;
			return;
		}
		if (pull) return publish(channel, { creating: false });
		if (busy) ran.current = true;
		else if (ran.current) publish(channel, { creating: false });
	}, [channel, creating, busy, pull]);
}
