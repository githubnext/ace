import type { CSSProperties } from "react";

import { AceAvatar } from "../ace-avatar/ace-avatar";
import { cn } from "../../lib/utils";
import { Badge } from "../../ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";

import type { SidebarRow } from "./session-item.types";
import {
	IconArchive as Archive,
	IconCloud,
	IconHand as HandWave,
	IconHash,
	IconLock,
	IconMerge,
	IconMessage as Msg,
	IconPullRequest,
	IconPullRequestClosed,
} from "../../icons";

type BadgeState = ReturnType<typeof resolveBadge>;

const ACTIVE_ICON = "group-data-[status=active]/row:text-current/80";

/**
 * Resolves the status-dot treatment for a row. Connection issues take
 * precedence over unread activity.
 */
function resolveBadge(data: SidebarRow): { show: boolean; pulse: boolean; color?: string } {
	if (data.connection === "error") {
		return { show: true, pulse: false, color: "var(--color-destructive)" };
	}
	// The channel's host is asleep or away: expected, not a fault.
	if (data.connection === "offline") {
		return { show: true, pulse: false, color: "var(--color-muted-foreground)" };
	}
	if (data.connection === "reconnecting") {
		return { show: true, pulse: true, color: "var(--color-warning)" };
	}
	// Transport is up but the session hasn't answered yet (resuming/rehydrating). Calm,
	// neutral pulse — "starting up", not a problem and not yet healthy/green.
	if (data.connection === "warming") {
		return { show: true, pulse: true, color: "var(--color-muted-foreground)" };
	}
	if (data.stopped) {
		return { show: true, pulse: false, color: "var(--color-muted-foreground)" };
	}
	if (data.unreadCount > 0 && data.pr?.state === "draft") {
		return { show: true, pulse: false, color: "var(--color-muted-foreground)" };
	}
	if (data.unreadCount > 0 && data.pr?.state === "closed") {
		return { show: true, pulse: false, color: "var(--color-destructive)" };
	}
	if (data.unreadCount > 0 && data.pr?.state === "merged") {
		return { show: true, pulse: false, color: "var(--color-merged)" };
	}
	if (data.unreadCount > 0 && data.pr?.state === "open") {
		return { show: true, pulse: false, color: "var(--color-accent)" };
	}
	if (data.unreadCount > 0) return { show: true, pulse: false };
	return { show: false, pulse: false };
}

function resolveIcon(data: SidebarRow) {
	if (data.kind === "lobby") return <Msg aria-label="Lobby" />;
	if (data.lifecycle === "archived") {
		return (
			<Archive
				className="size-3.5 text-muted-foreground group-data-[status=active]/row:text-current/80"
				aria-label="Archived channel"
			/>
		);
	}
	if (data.pr) {
		if (data.pr.state === "draft") {
			return (
				<IconPullRequest
					className={`size-4.5 shrink-0 text-muted-foreground ${ACTIVE_ICON}`}
					aria-label={`Draft PR ${data.pr.number}`}
				/>
			);
		}
		if (data.pr.state === "closed") {
			return (
				<IconPullRequestClosed
					className={`size-4.5 shrink-0 text-destructive ${ACTIVE_ICON}`}
					aria-label={`Closed PR ${data.pr.number}`}
				/>
			);
		}
		if (data.pr.state === "merged") {
			return (
				<IconMerge
					className={`size-4.5 shrink-0 text-merged ${ACTIVE_ICON}`}
					aria-label={`Merged PR ${data.pr.number}`}
				/>
			);
		}
		return (
			<IconPullRequest
				className={`size-4.5 shrink-0 text-accent ${ACTIVE_ICON}`}
				aria-label={`Open PR ${data.pr.number}`}
			/>
		);
	}
	if (data.private) return <IconLock aria-label="Private channel" />;
	if (data.hosted) return <IconCloud aria-label="Hosted channel" />;
	return <IconHash aria-label="Channel" />;
}

function working(data: SidebarRow) {
	return data.connection === "connected" && data.agent !== "idle";
}

function MentionBadge({ count, label }: { count: number; label: string }) {
	return (
		<span
			aria-label={label}
			className={cn(
				"grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-2xs leading-none font-semibold text-accent-foreground",
				"origin-center transition-[min-width,transform,opacity] duration-150 ease-out motion-reduce:transition-none",
				"animate-[mention-badge-grow_160ms_cubic-bezier(.215,.61,.355,1)_both] motion-reduce:animate-none",
				count < 10 && "w-5 px-0",
			)}
		>
			{count}
		</span>
	);
}

function AttentionWave({ label, mentionCount }: { label: string; mentionCount?: number }) {
	return (
		<span
			aria-label={label}
			className="grid size-4.5 place-items-center text-muted-foreground transition-opacity duration-150 ease-out motion-reduce:transition-none group-data-[status=active]/row:text-current/80"
		>
			<Badge
				show={Boolean(mentionCount)}
				className={cn(
					"size-4.5 translate-x-0.5 -translate-y-0.5 place-items-center",
					"[&>span:first-child]:grid [&>span:first-child]:size-4.5 [&>span:first-child]:place-items-center",
				)}
			>
				<HandWave
					aria-hidden
					className="size-4.5 overflow-visible origin-[70%_80%] animate-[attention-wave_3s_ease-in-out_infinite] motion-reduce:animate-none"
				/>
			</Badge>
		</span>
	);
}

function mentionText(count: number) {
	return `${count} direct ${count === 1 ? "mention" : "mentions"}`;
}

function attentionText(data: SidebarRow, showAttention: boolean) {
	if (!showAttention) return mentionText(data.mentionCount);
	if (data.mentionCount <= 0) return "Agent needs your attention";
	return `${mentionText(data.mentionCount)} and agent needs your attention`;
}

function canShowMention({
	badge,
	isWorking,
	selected,
	showAttention,
	count,
}: {
	badge: BadgeState;
	isWorking: boolean;
	selected?: boolean;
	showAttention: boolean;
	count: number;
}) {
	return count > 0 && !showAttention && !selected && !badge.color && !badge.pulse && !isWorking;
}

export function RowGlyph({ data, selected }: { data: SidebarRow; selected?: boolean }) {
	let badge = resolveBadge(data);
	let isWorking = working(data);
	let showAttention = Boolean(data.needsAttention) && !selected && !isWorking;
	let label = attentionText(data, showAttention);
	let showMention = canShowMention({
		badge,
		isWorking,
		selected,
		showAttention,
		count: data.mentionCount,
	});

	if (isWorking) {
		return (
			<AceAvatar
				loading
				className="size-4.5 bg-transparent text-primary"
			/>
		);
	}

	if (showAttention) {
		return <AttentionWave label={label} mentionCount={data.mentionCount} />;
	}

	if (showMention) {
		return <MentionBadge count={data.mentionCount} label={label} />;
	}

	let glyph = (
		<Badge
			show={badge.show}
			pulse={badge.pulse}
			style={badge.color ? { "--badge-color": badge.color } as CSSProperties : undefined}
		>
			{resolveIcon(data)}
		</Badge>
	);
	// The gray dot alone doesn't say why the channel can't open (#361) or run tools.
	let reason = data.connection === "offline"
		? `Offline: ${data.host} is unreachable`
		: data.stopped
		? "Stopped: its cloud workspace isn't running"
		: undefined;
	if (!reason) return glyph;
	return (
		<Tooltip>
			<TooltipTrigger render={<span role="img" aria-label={reason} className="grid" />}>
				{glyph}
			</TooltipTrigger>
			<TooltipContent side="right" sideOffset={8}>
				{reason}
			</TooltipContent>
		</Tooltip>
	);
}
