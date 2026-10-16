import { type ComponentType, type ReactNode, useId, useState } from "react";

import {
	IconBranch,
	IconChevronDown,
	IconCircleCheck,
	IconCircleDashed,
	IconCircleX,
	IconExternal,
	IconFileDiff,
	IconGlobe,
	IconIssue,
	IconLoader,
	IconMerge,
	IconPullRequest,
	IconPullRequestClosed,
	IconX,
} from "../../icons";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";
import { SplitButton } from "../../ui/split-button";
import { type Check, CHECK_ICONS, checkSummary, sortChecks } from "../checks/checks";
import { CreatePrMenu } from "../create-pr-menu";
import { LoadingSpinner } from "../session-item/session-item-loading";

export type DetailsPullState = "open" | "draft" | "closed" | "merged";
export type DetailsCheck = Check;
export type DetailsPull = {
	number: number;
	title: string;
	url: string;
	state: DetailsPullState;
	checks: DetailsCheck[];
};
export type DetailsSubagent = {
	id: string;
	task: string;
	model?: string;
	state: "running" | "done" | "failed" | "stopped";
};
export type DetailsLink = { url: string; label: string; kind: "issue" | "pull" | "web" };
export type DetailsFact = { label: string; value: string; title?: string };
/** One group's totals, such as committed or untracked files; ungrouped totals omit `group`. */
export type DetailsChanges = { group?: string; adds: number; dels: number; files: number };

export type SessionDetailsViewProps = {
	summary?: string;
	/** Totals for the chat's work, one per group the Diff shows; absent until first checked. */
	changes?: DetailsChanges[];
	branch?: string;
	/** `null` once looked up and none exists; absent while unknown or unavailable. */
	pull?: DetailsPull | null;
	subagents?: DetailsSubagent[];
	links?: DetailsLink[];
	facts?: DetailsFact[];
	/** A line under the facts, such as what the channel depends on. */
	note?: string;
	/** Whether a pull request is being opened for the branch. */
	creatingPr?: boolean;
	onDiff?: () => void;
	/** Offered in place of "No pull request" while one could be opened. */
	onCreatePr?: () => void;
	onCreateDraftPr?: () => void;
	onClose: () => void;
};

const LINKS = 5;
const ROW =
	"-mx-2 flex min-w-0 items-center gap-2 rounded-md squircle px-2 py-1 text-left text-xs text-foreground outline-none transition-colors focus-visible:outline-2 focus-visible:outline-ring/50";
const ACTIVE = "hover:bg-muted/60 focus-visible:bg-muted/60";
const GLYPH = "size-4 shrink-0";

type Icon = ComponentType<{ className?: string }>;

const PULL_ICONS: Record<DetailsPullState, [Icon, string]> = {
	open: [IconPullRequest, "text-success"],
	draft: [IconPullRequest, "text-muted-foreground"],
	closed: [IconPullRequestClosed, "text-destructive"],
	merged: [IconMerge, "text-merged"],
};

const SUBAGENT_ICONS: Record<DetailsSubagent["state"], [Icon, string]> = {
	running: [IconLoader, "animate-spin text-muted-foreground"],
	done: [IconCircleCheck, "text-success"],
	failed: [IconCircleX, "text-destructive"],
	stopped: [IconCircleDashed, "text-muted-foreground"],
};

const LINK_ICONS: Record<DetailsLink["kind"], Icon> = {
	issue: IconIssue,
	pull: IconPullRequest,
	web: IconGlobe,
};

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex min-w-0 flex-col gap-1 border-t pt-3">
			<h3 className="mb-1 text-xs font-medium text-muted-foreground">{title}</h3>
			{children}
		</section>
	);
}

function External(
	{ href, label, children }: { href: string; label?: string; children: ReactNode },
) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			aria-label={label}
			title={href}
			className={cn(ROW, ACTIVE, "group/row")}
		>
			{children}
			<IconExternal
				className="ml-auto size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
				aria-hidden
			/>
		</a>
	);
}

function Changes({ changes, onDiff }: { changes: DetailsChanges; onDiff?: () => void }) {
	const name = changes.group || "Changes";
	const files = `${changes.files.toLocaleString()} ${changes.files === 1 ? "file" : "files"}`;
	const label = `${name}: ${files}, ${changes.adds} additions, ${changes.dels} deletions`;
	const content = (
		<>
			<IconFileDiff className={cn(GLYPH, "text-muted-foreground")} aria-hidden />
			<span className="min-w-0 truncate">{name}</span>
			<span className="ml-auto flex shrink-0 gap-1.5 font-medium tabular-nums">
				{changes.group && <span className="font-normal text-muted-foreground">{files}</span>}
				<span className="text-success">+{changes.adds.toLocaleString()}</span>
				<span className="text-destructive">-{changes.dels.toLocaleString()}</span>
			</span>
		</>
	);
	if (!onDiff) {
		return <div className={ROW} aria-label={label}>{content}</div>;
	}
	return (
		<button type="button" className={cn(ROW, ACTIVE)} aria-label={label} onClick={onDiff}>
			{content}
		</button>
	);
}

/** The checks' summary, opening to each check; it opens on its own once any check fails. */
function Checks({ checks, summary: [Icon, color, label] }: {
	checks: DetailsCheck[];
	summary: [Icon, string, string];
}) {
	const id = useId();
	const [open, setOpen] = useState(checks.some((check) => check.state === "failed"));
	return (
		<>
			<button
				type="button"
				className={cn(ROW, ACTIVE)}
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setOpen(!open)}
			>
				<Icon className={cn(GLYPH, color)} aria-hidden />
				<span className="min-w-0 truncate">{label}</span>
				<IconChevronDown
					className={cn(
						"ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform",
						open && "rotate-180",
					)}
					aria-hidden
				/>
			</button>
			{open && (
				<div id={id} className="flex min-w-0 flex-col gap-1 pl-6">
					{sortChecks(checks).map((check) => {
						const [State, tone] = CHECK_ICONS[check.state];
						const content = (
							<>
								<State className={cn("size-3.5 shrink-0", tone)} aria-hidden />
								<span className="min-w-0 truncate">{check.name}</span>
							</>
						);
						const name = `${check.name}: ${check.state}`;
						return check.url
							? (
								<External key={check.url} href={check.url} label={name}>
									{content}
								</External>
							)
							: <div key={check.name} className={ROW} aria-label={name}>{content}</div>;
					})}
				</div>
			)}
		</>
	);
}

function CreatePr({ creating, onCreate, onDraft }: {
	creating: boolean;
	onCreate?: () => void;
	onDraft?: () => void;
}) {
	return (
		<SplitButton
			type="button"
			variant="ghost"
			size="sm"
			className="-mx-2 w-[calc(100%+1rem)]"
			primaryClassName="min-w-0 flex-1 justify-start gap-2 px-2 font-normal disabled:opacity-100"
			triggerClassName="text-muted-foreground disabled:opacity-100"
			contentClassName="inline-[max-content]"
			disabled={creating || !onCreate}
			onClick={onCreate}
			menu={<CreatePrMenu onCreateDraftPr={onDraft} />}
			menuLabel="Create PR options"
		>
			{creating
				? (
					<span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
						<LoadingSpinner size={14} />
					</span>
				)
				: <IconPullRequest className={cn(GLYPH, "text-success")} aria-hidden />}
			<span className="min-w-0 truncate">{creating ? "Creating PR" : "Create PR"}</span>
		</SplitButton>
	);
}

function Pull({ pull }: { pull: DetailsPull }) {
	const [Icon, color] = PULL_ICONS[pull.state];
	const failed = pull.checks.some((check) => check.state === "failed");
	// A closed pull request's checks are history; only live ones say anything about the branch.
	const summary = pull.state === "open" || pull.state === "draft"
		? checkSummary(pull.checks)
		: undefined;
	return (
		<>
			<External
				href={pull.url}
				label={`Pull request #${pull.number}, ${pull.state}: ${pull.title}`}
			>
				<Icon className={cn(GLYPH, color)} aria-hidden />
				<span className="min-w-0 truncate">{pull.title}</span>
				<span className="shrink-0 text-muted-foreground tabular-nums">#{pull.number}</span>
			</External>
			{summary && (
				<Checks
					key={failed ? "failed" : "passing"}
					checks={pull.checks}
					summary={summary}
				/>
			)}
		</>
	);
}

/**
 * Details of one channel. Each part shows once its data is known, so a channel with no work yet
 * shows only what exists.
 */
export function SessionDetailsView(
	{
		summary,
		changes,
		branch,
		pull,
		subagents,
		links,
		facts,
		note,
		creatingPr = false,
		onDiff,
		onCreatePr,
		onCreateDraftPr,
		onClose,
	}: SessionDetailsViewProps,
) {
	const [all, setAll] = useState(false);
	const shown = all ? links : links?.slice(0, LINKS);
	return (
		<aside
			aria-label="Channel details"
			className="flex h-full w-full min-w-0 max-w-full flex-col gap-3 overflow-y-auto py-2.5 pr-2 pl-4"
		>
			<section className="flex min-w-0 flex-col gap-1">
				<div className="flex min-w-0 items-center justify-between gap-2">
					<h2 className="text-xs font-medium text-muted-foreground">Summary</h2>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label="Close details sidebar"
						onClick={onClose}
					>
						<IconX aria-hidden />
					</Button>
				</div>
				<p className="line-clamp-4 text-xs leading-snug whitespace-pre-wrap break-words text-foreground">
					{summary || "No summary yet."}
				</p>
			</section>

			{(changes || branch || pull !== undefined) && (
				<section className="flex min-w-0 flex-col gap-1 border-t pt-3">
					{changes?.map((value) => (
						<Changes key={value.group || ""} changes={value} onDiff={onDiff} />
					))}
					{branch && (
						<div className={ROW} title={branch}>
							<IconBranch className={cn(GLYPH, "text-muted-foreground")} aria-hidden />
							<span className="min-w-0 truncate font-mono text-xs">{branch}</span>
						</div>
					)}
					{pull && <Pull pull={pull} />}
					{pull === null && (creatingPr || onCreatePr) && (
						<CreatePr creating={creatingPr} onCreate={onCreatePr} onDraft={onCreateDraftPr} />
					)}
					{pull === null && !creatingPr && !onCreatePr && (
						<div className={cn(ROW, "text-muted-foreground")}>
							<IconPullRequest className={GLYPH} aria-hidden />
							<span className="min-w-0 truncate">No pull request</span>
						</div>
					)}
				</section>
			)}

			{subagents && subagents.length > 0 && (
				<Section title="Subagents">
					{subagents.map((agent) => {
						const [Icon, color] = SUBAGENT_ICONS[agent.state];
						return (
							<div
								key={agent.id}
								className={ROW}
								title={agent.task}
								aria-label={`${agent.state}: ${agent.task}`}
							>
								<Icon className={cn(GLYPH, color)} aria-hidden />
								<span className="min-w-0 flex-1 truncate">{agent.task}</span>
								{agent.model && (
									<span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
										{agent.model}
									</span>
								)}
							</div>
						);
					})}
				</Section>
			)}

			{shown && shown.length > 0 && (
				<Section title="Links">
					{shown.map((link) => {
						const Icon = LINK_ICONS[link.kind];
						return (
							<External key={link.url} href={link.url}>
								<Icon className={cn(GLYPH, "text-muted-foreground")} aria-hidden />
								<span className="min-w-0 truncate">{link.label}</span>
							</External>
						);
					})}
					{links!.length > LINKS && (
						<button
							type="button"
							className={cn(ROW, ACTIVE, "text-muted-foreground")}
							aria-expanded={all}
							onClick={() => setAll(!all)}
						>
							<span className={GLYPH} aria-hidden />
							{all ? "Show fewer" : `Show all ${links!.length}`}
						</button>
					)}
				</Section>
			)}

			{facts && facts.length > 0 && (
				<Section title="Channel">
					<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
						{facts.map((fact) => (
							<div key={fact.label} className="contents">
								<dt className="text-muted-foreground">{fact.label}</dt>
								<dd className="min-w-0 truncate text-right tabular-nums" title={fact.title}>
									{fact.value}
								</dd>
							</div>
						))}
					</dl>
					{note && <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{note}</p>}
				</Section>
			)}
		</aside>
	);
}
