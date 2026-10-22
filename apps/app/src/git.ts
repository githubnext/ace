import { useEffect, useRef } from "react";

import type { Changes, GithubCheck, GithubPull } from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";
import { type GitAction, toast } from "@ace/ui";
import {
	IconBranch,
	IconCommit,
	IconMerge,
	IconPullRequest,
	IconPullRequestClosed,
	IconPush,
	IconReview,
} from "@ace/ui/icons";

import { type Ask, publish, useDetails } from "./details";
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

const ASKS: Record<Exclude<Ask, "create">, (pull: number) => string> = {
	commit: () =>
		"Commit this lane's uncommitted work, following this repository's commit conventions. Leave out anything that doesn't belong, and don't push.",
	push: () =>
		"Push this branch's commits to its remote, with `lane push` in a lane and `git push` otherwise, following this repository's instructions. Don't open a pull request.",
	update: (pull) =>
		`Update #${pull} with this lane's work: commit what belongs in it, then push with \`lane push\`, following this repository's instructions.`,
	rebase: () =>
		"Rebase this lane onto the latest of its base: `git fetch origin`, rebase, resolve any conflicts, and check the result still builds. If the lane has an open pull request, push with `lane push`.",
	review: (pull) =>
		`#${pull} has changes requested. Read its reviews and review comments with \`gh\`, address them in this lane, and push with \`lane push\`.`,
	ready: (pull) => `Mark #${pull} ready for review with \`gh pr ready\`.`,
	merge: (pull) =>
		`Merge #${pull} with \`gh pr merge\`, following this repository's instructions for merging. If GitHub refuses, say why.`,
	close: (pull) => `Close #${pull} with \`gh pr close\`, keeping its branch.`,
};

const PENDING: Record<Exclude<Ask, "create">, Pick<GitAction, "label" | "icon">> = {
	commit: { label: "Committing", icon: IconCommit },
	push: { label: "Pushing", icon: IconPush },
	update: { label: "Updating PR", icon: IconPush },
	rebase: { label: "Rebasing", icon: IconBranch },
	review: { label: "Addressing review", icon: IconReview },
	ready: { label: "Marking ready", icon: IconPullRequest },
	merge: { label: "Merging", icon: IconMerge },
	close: { label: "Closing PR", icon: IconPullRequestClosed },
};

/** Uncommitted or untracked work; older hosts don't group files, so they report none. */
function dirty(changes: Changes) {
	return !!changes.dirs || changes.files.some((file) => file.state && file.state !== "committed");
}

/**
 * Git and pull request actions for a chat's lane. Each one asks the chat's agent, which works in
 * the lane and lands it through lane, so a click never pushes past `lane push` or the repository's
 * own pull request instructions. They're offered only while the agent could take the request now.
 */
export function useGit(channel: Listing, chat: number, user: string) {
	const { info, changes, pull, shared, asked } = useDetails(channel.id);
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

	function request(what: Ask, text: string) {
		publish(channel.id, { asked: what });
		ask(text).catch(() => publish(channel.id, { asked: null }));
	}

	const actions: GitAction[] = [];
	if (asked && asked !== "create") actions.push({ ...PENDING[asked], pending: true });
	else if (ready && changes) {
		const number = pull?.number || 0;
		const live = pull?.state === "open" || pull?.state === "draft";
		const go = (what: Exclude<Ask, "create">) => () => request(what, ASKS[what](number));
		// GitHub's head differing from the lane's means commits it hasn't been pushed.
		const unpushed = live && !!pull.sha && pull.sha !== changes.head;
		const close = { label: "Close PR", icon: IconPullRequestClosed, onClick: go("close") };
		if (changes.behind) {
			const commits = `${changes.behind} ${changes.behind === 1 ? "commit" : "commits"}`;
			actions.push({
				label: "Rebase",
				icon: IconBranch,
				tone: "text-accent",
				count: `+${changes.behind}`,
				title: `${commits} on the lane's base since it forked`,
				onClick: go("rebase"),
			});
		}
		if (!live && dirty(changes)) {
			actions.push({ label: "Commit", icon: IconCommit, onClick: go("commit") });
		}
		// Not every project uses pull requests, or has its remote on GitHub.
		if (!live && changes.ahead) {
			const commits = `${changes.ahead} ${changes.ahead === 1 ? "commit" : "commits"}`;
			actions.push({
				label: "Push",
				icon: IconPush,
				count: `${changes.ahead}`,
				title: `${commits} its remote doesn't have`,
				onClick: go("push"),
			});
		}
		if (live && (unpushed || dirty(changes))) {
			actions.push({
				label: "Update PR",
				icon: IconPush,
				tone: "text-accent",
				onClick: go("update"),
			});
		}
		if (live && pull.review === "changes") {
			actions.push({ label: "Address review", icon: IconReview, onClick: go("review") });
		}
		if (pull?.state === "draft") {
			actions.push({
				label: "Ready for review",
				icon: IconPullRequest,
				onClick: go("ready"),
				menu: [close],
			});
		}
		// Offered only once GitHub would merge it as is, with nothing left to push.
		const passing = pull?.checks.every((check) => ["passed", "skipped"].includes(check.state));
		const approved = pull?.review !== "changes" && pull?.review !== "required";
		if (pull?.state === "open" && passing && approved && !unpushed) {
			actions.push({
				label: "Merge PR",
				icon: IconMerge,
				tone: "text-merged",
				onClick: go("merge"),
				menu: [close],
			});
		} else if (pull?.state === "open") {
			// Until it can merge, Close has no Merge menu to sit in.
			actions.push(close);
		}
	}

	// A closed pull request, or a merged one the branch has moved past, leaves its work unproposed.
	const past = pull?.state === "closed"
		|| (pull?.state === "merged" && !!changes && (pull.sha !== changes.head || dirty(changes)));
	const open = ready && changed && (pull === null || past) && !asked;
	return {
		creatingPr: asked === "create",
		createPr: open ? () => request("create", create(false)) : undefined,
		createDraftPr: open ? () => request("create", create(true)) : undefined,
		fixChecks: ready && pull
			? (failed: GithubCheck[]) => void ask(fix(pull, failed)).catch(() => {})
			: undefined,
		actions,
	};
}

/**
 * Ends an action's pending state once the run it started ends, or for Create PR once the pull
 * request exists. Called once per shown channel, by its details, which stay mounted while the
 * channel is shown.
 */
export function useAsked(channel: string, busy: boolean, pull: GithubPull | null | undefined) {
	const { asked } = useDetails(channel);
	const ran = useRef(false);
	useEffect(() => {
		if (!asked) {
			ran.current = false;
			return;
		}
		// A closed or merged pull request from before isn't the one Create PR asked for.
		const live = pull?.state === "open" || pull?.state === "draft";
		if (asked === "create" && live) return publish(channel, { asked: null });
		if (busy) ran.current = true;
		else if (ran.current) publish(channel, { asked: null });
	}, [channel, asked, busy, pull]);
}
