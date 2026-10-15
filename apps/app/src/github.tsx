import { useId, useState } from "react";

import type { GithubFilter, GithubItem, GithubKind, GithubList } from "@ace/channel/protocol";
import { checkoutId } from "@ace/host/protocol";
import {
	Button,
	buttonVariants,
	Input,
	ProjectSidebar,
	type SessionSidebarRepo,
	useLayoutLeft,
	useLocalStorage,
	useMedia,
} from "@ace/ui";
import {
	IconCircleCheck,
	IconExternal,
	IconHash,
	IconIssue,
	IconListTree,
	IconLoader,
	IconMerge,
	IconPullRequest,
	IconPullRequestClosed,
	IconRotate,
	IconSearch,
	IconSidebar,
} from "@ace/ui/icons";

import { type Query, useGithub } from "./github-cache";
import { host } from "./host";
import type { AppProject } from "./projects";

const NAMES = { issues: "Issues", prs: "Pull requests" };
const DATE = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
});

type Filter = { state: GithubFilter; search: string; limit: number };
const DEFAULT_FILTER: Filter = { state: "open", search: "", limit: 50 };

const ICONS = {
	issues: { open: IconIssue, closed: IconCircleCheck, merged: IconMerge, draft: IconIssue },
	prs: {
		open: IconPullRequest,
		closed: IconPullRequestClosed,
		merged: IconMerge,
		draft: IconPullRequest,
	},
};
const COLORS = {
	issues: {
		open: "text-accent",
		closed: "text-merged",
		merged: "text-merged",
		draft: "text-muted-foreground",
	},
	prs: {
		open: "text-accent",
		closed: "text-destructive",
		merged: "text-merged",
		draft: "text-muted-foreground",
	},
};

function useGithubFilter(kind: GithubKind, project: AppProject) {
	return useLocalStorage<Filter>(
		`ace:github-filter:${host.url}:${checkoutId(project.host, project.path)}:${kind}`,
		DEFAULT_FILTER,
	);
}

export function GithubSidebar({ kind, project, repos, connected, onProject, onOpen }: {
	kind: GithubKind;
	project: AppProject;
	repos: SessionSidebarRepo[];
	connected: boolean;
	onProject: (id: string) => void;
	onOpen: () => void;
}) {
	const [filter, setFilter] = useGithubFilter(kind, project);
	const left = useLayoutLeft();
	const phone = useMedia("(width < 40rem)");
	return (
		<ProjectSidebar
			className="min-h-0 w-full min-w-0 flex-1 bg-transparent"
			projectName={project.label}
			repos={repos}
			selectedRepoId={project.id}
			onRepoChange={(repo) => onProject(repo.id)}
			onAddRepo={connected ? onOpen : undefined}
		>
			<h2 className="px-3 pt-2 pb-1.5 text-xs font-medium text-muted-foreground">{NAMES[kind]}</h2>
			<nav className="flex flex-col gap-0.5 px-1.5" aria-label={`${NAMES[kind]} state`}>
				{(["open", "closed", "all"] as const).map((state) => {
					const Icon = state === "all" ? IconListTree : ICONS[kind][state];
					return (
						<Button
							key={state}
							variant="ghost"
							size="sm"
							className="h-7.5 justify-start gap-2 rounded-lg border border-transparent px-2 text-muted-foreground aria-pressed:selected-surface aria-pressed:bg-popover/35 aria-pressed:text-accent-text aria-pressed:hover:text-accent-text dark:aria-pressed:bg-black/32"
							aria-pressed={filter.state === state}
							onClick={() => {
								setFilter({ ...filter, state, limit: 50 });
								if (phone) left.setOpen(false);
							}}
						>
							<Icon className="size-4" aria-hidden />
							{state[0]!.toUpperCase() + state.slice(1)}
						</Button>
					);
				})}
			</nav>
		</ProjectSidebar>
	);
}

function StateIcon({ item }: { item: Pick<GithubItem, "kind" | "state"> }) {
	const Icon = ICONS[item.kind][item.state];
	const color = COLORS[item.kind][item.state];
	return <Icon className={`size-4 shrink-0 ${color}`} aria-hidden />;
}

function Notice({ error, loading, empty, onRetry }: {
	error?: string;
	loading?: boolean;
	empty: string;
	onRetry: () => void;
}) {
	return (
		<div
			className="flex flex-col items-center justify-center gap-3 px-5 py-16 text-center text-sm text-muted-foreground"
			role={error ? "alert" : "status"}
		>
			{loading && !error && <IconLoader className="size-5 animate-spin" aria-hidden />}
			<p>{error || (loading ? "Loading from GitHub…" : empty)}</p>
			{error && <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>}
		</div>
	);
}

function Refresh({ loading, onClick }: { loading: boolean; onClick: () => void }) {
	return (
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label="Refresh from GitHub"
			disabled={loading}
			onClick={onClick}
		>
			<IconRotate className={loading ? "animate-spin" : ""} aria-hidden />
		</Button>
	);
}

function Labels({ labels }: Pick<GithubItem, "labels">) {
	return labels.map((label) => (
		<span
			key={label.name}
			className="inline-flex max-w-48 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
		>
			<span
				className="size-1.5 shrink-0 rounded-full"
				style={{ backgroundColor: `#${label.color}` }}
			/>
			<span className="truncate">{label.name}</span>
		</span>
	));
}

function Items({ items, busy, onChannel }: {
	items: GithubItem[];
	busy: boolean;
	onChannel?: (item: GithubItem) => void;
}) {
	const id = useId();
	return (
		<ul className="divide-y divide-border">
			{items.map((item) => (
				<li
					key={item.number}
					className="group/row flex items-start gap-3 px-4 py-4 hover:bg-muted/40 has-focus-visible:bg-muted/40 sm:px-6"
				>
					<span className="pt-0.5">
						<StateIcon item={item} />
					</span>
					<span className="flex min-w-0 flex-1 flex-col gap-1.5">
						<a
							id={`${id}-${item.number}`}
							href={item.url}
							target="_blank"
							rel="noopener noreferrer"
							className="self-start rounded-sm text-sm font-medium text-pretty outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/30"
						>
							{item.title}
						</a>
						<span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
							<span>#{item.number}</span>
							<span className="capitalize">{item.state}</span>
							<span>by {item.author}</span>
							<span>· Updated {DATE.format(new Date(item.updated))}</span>
						</span>
						{item.labels.length > 0 && (
							<span className="flex flex-wrap gap-1">
								<Labels labels={item.labels} />
							</span>
						)}
					</span>
					{/* Opacity keeps the actions in the tab order; devices without hover always show them. */}
					<span className="-my-0.5 flex shrink-0 items-center gap-0.5 transition-opacity duration-150 motion-reduce:transition-none notouch:opacity-0 notouch:group-hover/row:opacity-100 notouch:group-focus-within/row:opacity-100">
						{onChannel && (
							<Button
								variant="ghost"
								size="sm"
								className="text-muted-foreground"
								aria-label="Open in a channel"
								aria-describedby={`${id}-${item.number}`}
								disabled={busy}
								onClick={() => onChannel(item)}
							>
								<IconHash aria-hidden />
								<span className="hidden sm:inline">Open in a channel</span>
							</Button>
						)}
						<a
							href={item.url}
							target="_blank"
							rel="noopener noreferrer"
							className={buttonVariants({
								variant: "ghost",
								size: "sm",
								className: "text-muted-foreground",
							})}
							aria-label="Open on GitHub"
							// WebKit skips links on Tab unless macOS keyboard navigation is on.
							tabIndex={0}
							aria-describedby={`${id}-${item.number}`}
						>
							<IconExternal aria-hidden />
							<span className="hidden sm:inline">Open on GitHub</span>
						</a>
					</span>
				</li>
			))}
		</ul>
	);
}

function Results({ kind, repo, data, filter, busy, onFilter, onRetry, onChannel }: {
	kind: GithubKind;
	repo: Query<string | null>;
	data: Query<GithubList>;
	filter: Filter;
	busy: boolean;
	onFilter: (filter: Filter) => void;
	onRetry: () => void;
	onChannel?: (item: GithubItem) => void;
}) {
	const error = repo.error || data.error;
	const loading = repo.loading || data.loading;
	if (!repo.value) {
		return (
			<Notice
				error={error}
				loading={repo.value === undefined && loading}
				empty="This project has no GitHub remote."
				onRetry={onRetry}
			/>
		);
	}
	if (!data.value?.items.length) {
		const state = filter.state === "all" ? "" : `${filter.state} `;
		const scope = filter.search ? " match your search" : " in this project";
		return (
			<Notice
				error={error}
				loading={data.value === undefined && loading}
				empty={`No ${state}${NAMES[kind].toLowerCase()}${scope}.`}
				onRetry={onRetry}
			/>
		);
	}
	return (
		<>
			{error && <p role="alert" className="px-4 py-2 text-xs text-destructive">{error}</p>}
			<Items items={data.value.items} busy={busy} onChannel={onChannel} />
			{data.value.more && filter.limit < 1000 && (
				<div className="flex justify-center border-t p-4">
					<Button
						variant="outline"
						disabled={loading}
						onClick={() => onFilter({ ...filter, limit: Math.min(1000, filter.limit + 50) })}
					>
						Load more
					</Button>
				</div>
			)}
			{data.value.items.length === 1000 && (
				<p className="p-4 text-center text-xs text-muted-foreground">
					Showing the first 1,000 results. Search to narrow the list.
				</p>
			)}
		</>
	);
}

function prompt(item: GithubItem): string {
	const work = item.kind === "prs"
		? "Continue this pull request on its existing branch: make the needed changes, validate them, and push them to it instead of opening a new pull request."
		: "Make the needed changes, validate them, and open or update a pull request.";
	return `Let's work on ${item.title} (${item.url}). Read the item and its discussion and inspect the project. ${work}`;
}

export function Github({ kind, project, connected, onCreate }: {
	kind: GithubKind;
	project: AppProject;
	connected: boolean;
	onCreate?: (text: string) => Promise<void>;
}) {
	const [filter, setFilter] = useGithubFilter(kind, project);
	const [search, setSearch] = useState(filter.search);
	const [busy, setBusy] = useState(false);
	const left = useLayoutLeft();
	const repo = useGithub<string | null>({
		op: "project-repo",
		project: project.path,
		host: project.host,
	});
	const list = useGithub<GithubList>(
		repo.value ? { op: "github-list", repo: repo.value, kind, ...filter } : undefined,
	);
	const loading = repo.loading || list.loading;
	function refresh() {
		repo.refresh();
		list.refresh();
	}
	async function start(item: GithubItem) {
		if (!onCreate || busy) return;
		setBusy(true);
		try {
			await onCreate(prompt(item));
		} finally {
			setBusy(false);
		}
	}
	return (
		<section className="flex h-full min-h-0 flex-col bg-background">
			<header className="flex h-8 shrink-0 items-center gap-3 border-b pr-2 electrobun-webkit-app-region-drag">
				<div className="flex h-full w-8 shrink-0 items-center justify-center border-r electrobun-webkit-app-region-no-drag">
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`Toggle ${NAMES[kind].toLowerCase()} sidebar`}
						aria-controls="sidebar"
						aria-expanded={left.open}
						onClick={() => left.setOpen((value) => !value)}
					>
						<IconSidebar className="size-4" aria-hidden />
					</Button>
				</div>
				<h1 className="text-sm font-medium">{NAMES[kind]}</h1>
				<div className="ml-auto flex min-w-0 items-center gap-2 electrobun-webkit-app-region-no-drag">
					<span className="hidden truncate text-xs text-muted-foreground sm:block">
						{repo.value}
					</span>
					<Refresh loading={loading} onClick={refresh} />
				</div>
			</header>
			<div className="shrink-0 border-b px-4 py-3 sm:px-6">
				<form
					className="flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						setFilter({ ...filter, search: search.trim(), limit: 50 });
					}}
				>
					<Input
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder={`Search ${NAMES[kind].toLowerCase()}…`}
						aria-label={`Search ${NAMES[kind].toLowerCase()}`}
					/>
					<Button type="submit" variant="outline" size="icon" aria-label="Search GitHub">
						<IconSearch aria-hidden />
					</Button>
				</form>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
				<Results
					kind={kind}
					repo={repo}
					data={list}
					filter={filter}
					busy={busy || !connected}
					onFilter={setFilter}
					onRetry={refresh}
					onChannel={onCreate && ((item) => void start(item))}
				/>
			</div>
		</section>
	);
}
