import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
	Button,
	buttonVariants,
	ChatComposer,
	type ChatComposerHandle,
	Facepile,
	ProjectPicker,
	serialize,
	type SessionSidebarRepo,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ace/ui";
import {
	IconChevronDown,
	IconCircleX,
	IconCloud,
	IconExternal,
	IconGlobe,
	IconHash,
	IconLaptop,
	IconMessage,
	IconPlus,
	IconRotate,
} from "@ace/ui/icons";
import type { GithubList, ModelRef } from "@ace/channel/protocol";
import type { Listing, People, Presence } from "@ace/host/protocol";

import type { Outcome } from "./attention";
import { Notice } from "./composer";
import { desktop, here } from "./desktop";
import { prompt, StateIcon } from "./github";
import { useGithub } from "./github-cache";
import { host } from "./host";
import { InitGit } from "./open-project";
import type { AppProject } from "./projects";
import { pulse, type Teammate } from "./pulse";
import { byBranch, needsYou, pickBackUp, type Work } from "./work";

/**
 * A project's dashboard draft and history follow its identity, so setting up a GitHub project here
 * keeps them. Earlier versions scoped each to one checkout; the first one found moves over once.
 */
function adopt(project: AppProject): string {
	const scope = `/projects/${project.id}/dashboard`;
	for (const kind of ["draft", "history"]) {
		const key = `ace:${kind}:${scope}`;
		try {
			// useDraft still moves drafts that earlier versions kept in sessionStorage.
			const stores = kind === "draft" ? [localStorage, sessionStorage] : [localStorage];
			if (stores.some((store) => store.getItem(key) !== null)) continue;
			for (const checkout of project.checkouts) {
				const legacy = `ace:${kind}:/projects/${checkout}/dashboard`;
				const store = legacy !== key && stores.find((store) => store.getItem(legacy) !== null);
				if (!store) continue;
				// A failed write throws before the legacy copy is removed.
				store.setItem(key, store.getItem(legacy)!);
				store.removeItem(legacy);
				break;
			}
		} catch {
			// Unavailable storage leaves both scopes as they were.
		}
	}
	return scope;
}

const MODES = [{ id: "ace", name: "Ace", placeholder: "Start a new channel" }];

/** Where a new channel's agent works, offered while the cloud compute beta is on. */
const PLACES = [
	{
		id: "local",
		name: desktop ? "This Mac" : "This host",
		description: "This checkout",
		icon: IconLaptop,
	},
	{
		id: "cloud",
		name: "Run in cloud",
		description: "A team compute container",
		icon: IconCloud,
	},
];

/** Teammates' pulse covers what ended since this project's dashboard was last opened here. */
const FIRST_VISIT = 24 * 60 * 60_000;

function useLastVisit(project: string): number {
	const key = `ace:dashboard-visit:${host.url}:${project}`;
	const [since] = useState(() => {
		try {
			return Number(localStorage.getItem(key)) || Date.now() - FIRST_VISIT;
		} catch {
			return Date.now() - FIRST_VISIT;
		}
	});
	useEffect(() => {
		try {
			localStorage.setItem(key, String(Date.now()));
		} catch {
			// Without storage, every visit covers the last day.
		}
	}, [key]);
	return since;
}

function Section({ title, action, children }: {
	title: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="mx-auto mt-10 max-w-[39rem]">
			<div className="mb-3 flex min-h-7 items-center justify-between gap-3">
				<h2 className="text-sm font-medium">{title}</h2>
				{action}
			</div>
			{children}
		</section>
	);
}

const ROW =
	"flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/30";

function ChannelLink({ channel, onChannel }: {
	channel: Listing;
	onChannel: (channel: Listing) => void;
}) {
	return (
		<button
			type="button"
			className="rounded-sm font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/30"
			onClick={() => onChannel(channel)}
		>
			#{channel.name}
		</button>
	);
}

/** The channel on an item opens it, whoever owns it; otherwise a new channel starts on it. */
function WorkRow({ work, owner, busy, onChannel, onStart }: {
	work: Work;
	owner?: string;
	busy: boolean;
	onChannel: (channel: Listing) => void;
	onStart?: (work: Work) => void;
}) {
	const { item, channel } = work;
	return (
		<li className="flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-muted/40">
			<StateIcon item={item} />
			<span className="min-w-0 flex-1">
				<a
					href={item.url}
					target="_blank"
					rel="noopener noreferrer"
					className="block truncate rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/30"
				>
					{item.title}
				</a>
				<span className="mt-0.5 block truncate text-xs text-muted-foreground">
					#{item.number} · {work.reason}
					{channel && ` · in #${channel.name}${owner ? ` · ${owner}` : ""}`}
				</span>
			</span>
			{channel
				? (
					<Button
						size="sm"
						variant="ghost"
						aria-label={`Continue in #${channel.name}`}
						onClick={() => onChannel(channel)}
					>
						Continue
					</Button>
				)
				: onStart
				? (
					<Button
						size="sm"
						variant="ghost"
						aria-label={`Open #${item.number} in a channel`}
						disabled={busy}
						onClick={() => onStart(work)}
					>
						<IconHash aria-hidden />
						<span className="hidden sm:inline">Open in a channel</span>
					</Button>
				)
				: (
					<a
						href={item.url}
						target="_blank"
						rel="noopener noreferrer"
						className={buttonVariants({ variant: "ghost", size: "sm" })}
						aria-label={`Open #${item.number} on GitHub`}
						// WebKit skips links on Tab unless macOS keyboard navigation is on.
						tabIndex={0}
					>
						<IconExternal aria-hidden />
						<span className="hidden sm:inline">Open on GitHub</span>
					</a>
				)}
		</li>
	);
}

function TeammateRow({ teammate, onChannel }: {
	teammate: Teammate;
	onChannel: (channel: Listing) => void;
}) {
	const { login, here, active, finished, failed } = teammate;
	const list = (channels: Listing[]) =>
		channels.map((channel, index) => (
			<span key={channel.id}>
				{index > 0 && ", "}
				<ChannelLink channel={channel} onChannel={onChannel} />
			</span>
		));
	return (
		<li className="flex min-w-0 gap-3 px-3 py-2.5 text-sm">
			<Facepile
				className="mt-0.5 shrink-0"
				avatars={[{ src: `https://github.com/${login}.png?size=40`, alt: login, dimmed: !here }]}
			/>
			<span className="flex min-w-0 flex-1 flex-col gap-1">
				<span>
					<span className="font-medium">{login}</span>
					{here && (
						<span className="text-muted-foreground">
							{" "}· {here === "here" ? "Here" : "Away"}
						</span>
					)}
				</span>
				{active.map((channel) => (
					<span key={channel.id} className="min-w-0 text-xs text-muted-foreground">
						<ChannelLink channel={channel} onChannel={onChannel} />
						{channel.busy && " · working"}
						{channel.summary && <span className="line-clamp-2">{channel.summary}</span>}
					</span>
				))}
				{finished.length > 0 && (
					<span className="text-xs text-muted-foreground">Finished in {list(finished)}</span>
				)}
				{failed.length > 0 && (
					<span className="text-xs text-muted-foreground">Failed in {list(failed)}</span>
				)}
			</span>
		</li>
	);
}

export function Dashboard(
	{
		project,
		repos,
		channels,
		user,
		people,
		presence,
		attention,
		local,
		connected,
		onSetup,
		onInit,
		onProject,
		onOpen,
		onClone,
		onChannel,
		onCreate,
		onProviders,
		cloud,
	}: {
		project: AppProject;
		repos: SessionSidebarRepo[];
		channels: Listing[];
		user: string;
		people: People;
		presence: Presence[] | undefined;
		attention: Map<string, Outcome>;
		local: boolean;
		connected: boolean;
		/** Offered for a GitHub project with no checkout on this host. */
		onSetup?: () => void;
		onInit: () => Promise<void>;
		onProject: (id: string) => void;
		onOpen: () => void;
		onClone: () => void;
		onChannel: (channel: Listing) => void;
		onCreate: (text?: string, onCreated?: () => void, cloud?: boolean) => Promise<void>;
		onProviders: () => void;
		/** The cloud compute beta is on and this project has a GitHub repository. */
		cloud?: boolean;
	},
) {
	const composer = useRef<ChatComposerHandle>(null);
	const [busy, setBusy] = useState(false);
	const [place, setPlace] = useState("local");
	const [scope] = useState(() => adopt(project));
	const needsGit = local && project.git === false;
	const creatable = (local && !needsGit) || !!onSetup;
	const active = channels.filter((channel) => channel.state !== "archived")
		.sort((a, b) => b.created - a.created);
	const since = useLastVisit(project.id);
	const now = Date.now();
	const list = (kind: "prs" | "issues", search: string) =>
		project.repo
			? {
				op: "github-list" as const,
				repo: project.repo,
				kind,
				state: "open" as const,
				search,
				limit: 20,
			}
			: undefined;
	// `@me` is this host's GitHub CLI account, the only one Ace reads GitHub with.
	const authored = useGithub<GithubList>(list("prs", "author:@me"));
	const reviews = useGithub<GithubList>(list("prs", "review-requested:@me"));
	const assigned = useGithub<GithubList>(list("issues", "assignee:@me"));
	const github = [authored, reviews, assigned];
	const branches = byBranch(channels, user);
	const work = pickBackUp(authored.value?.items || [], assigned.value?.items || [], branches);
	const waiting = needsYou(channels, attention, reviews.value?.items || [], branches);
	const team = pulse(channels, presence, people, user, since, now);
	const owner = (channel?: Listing) =>
		channel && channel.owner !== user ? people[channel.owner] || channel.owner : undefined;
	const settingsVersion = useSyncExternalStore(host.subscribe, () => host.settingsVersion);
	const [models, setModels] = useState<ModelRef[]>();
	useEffect(() => {
		if (!local || !connected) return;
		let active = true;
		// An unread answer offers no setup; starting then reports whatever failed.
		host.request<ModelRef[]>({ op: "models" }).then(
			(value) => active && setModels(value),
			() => active && setModels(undefined),
		);
		return () => {
			active = false;
		};
	}, [local, connected, settingsVersion]);
	// A cloud channel runs on the service's credentials, not this host's.
	const unprovided = models?.length === 0 && place === "local";
	const hour = new Date().getHours();
	const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

	async function start(text?: string) {
		if (busy) return;
		// Its agent would fail for want of a key; setup keeps the text for sending after.
		if (unprovided) return onProviders();
		setBusy(true);
		try {
			await onCreate(text, () => {
				const input = composer.current;
				const doc = input?.get();
				if (input && doc && serialize(doc) === text) input.clear();
			}, cloud && place === "cloud");
		} finally {
			setBusy(false);
		}
	}

	async function open(item: Work) {
		if (busy) return;
		setBusy(true);
		try {
			await onCreate(prompt(item.item), undefined, cloud && place === "cloud");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mx-auto min-h-full w-full max-w-[72rem] px-4 pb-12">
			<section className="mx-auto flex max-w-[39rem] flex-col items-center gap-4 pt-10 text-center md:pt-16">
				<ProjectPicker
					repos={repos}
					selectedRepoId={project.id}
					onRepoChange={(repo) => onProject(repo.id)}
					onAddRepo={connected ? onOpen : undefined}
					onCloneRepo={connected ? onClone : undefined}
					trigger={
						<button
							type="button"
							aria-label={`Select project, currently ${project.label}`}
							className="group inline-flex max-w-full select-none items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs font-medium text-muted-foreground outline-none transition-[background-color,color,box-shadow] hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
						/>
					}
				>
					<span className="truncate">{project.label}</span>
					<IconChevronDown className="size-3 shrink-0" aria-hidden />
				</ProjectPicker>
				<h1 className="text-balance text-display-xs leading-[1.2] font-medium tracking-tight sm:text-display-sm lg:text-display">
					{greeting}
				</h1>
				<p className="max-w-[34rem] text-pretty text-sm leading-[1.55] text-foreground/65">
					{local
						? `What would you like to work on in ${project.label}?`
						: `Catch up on ${project.label}’s channels on ${[...project.hosts].join(", ")}. ${
							onSetup
								? `Set it up on ${here} to start channels here.`
								: "Open a checkout on this host to start channels here."
						}`}
				</p>
				{onSetup && (
					<Button variant="outline" disabled={!connected} onClick={onSetup}>
						Set up on {here}
					</Button>
				)}
			</section>
			{needsGit && (
				<div className="mx-auto mt-9 max-w-[39rem]">
					<InitGit name={project.label} disabled={!connected} onInit={onInit} />
				</div>
			)}
			{creatable && (
				<div className="mx-auto mt-9 max-w-[39rem]">
					<ChatComposer
						ref={composer}
						scope={scope}
						modes={MODES}
						mode="ace"
						agents={cloud ? PLACES : undefined}
						agent={place}
						onAgentChange={setPlace}
						mic
						tools={false}
						canAttach={false}
						canStop={false}
						busy={busy}
						submitBusy={busy}
						canSend={connected && !busy}
						clearOnSend={false}
						onSend={({ doc }) => void start(serialize(doc))}
					/>
					{unprovided && (
						<Notice
							action={
								<Button size="sm" variant="outline" onClick={onProviders}>
									Set up a provider
								</Button>
							}
						>
							Add a model provider's API key so Ace can work on {project.label}.
						</Notice>
					)}
				</div>
			)}
			{waiting.length > 0 && (
				<Section title="Needs you">
					<ul className="flex flex-col gap-1">
						{waiting.map((value) =>
							value.kind === "review"
								? (
									<WorkRow
										key={value.work.item.url}
										work={value.work}
										owner={owner(value.work.channel)}
										busy={busy}
										onChannel={onChannel}
									/>
								)
								: (
									<li key={value.channel.id} className="flex">
										<button
											type="button"
											className={`${ROW} flex-1`}
											onClick={() => onChannel(value.channel)}
										>
											{value.outcome === "failed"
												? <IconCircleX className="size-4 shrink-0 text-destructive" aria-hidden />
												: <IconMessage className="size-4 shrink-0 text-accent" aria-hidden />}
											<span className="min-w-0 flex-1">
												<span className="block truncate">{value.channel.name}</span>
												<span className="mt-0.5 block truncate text-xs text-muted-foreground">
													{value.outcome === "failed"
														? "Your run failed"
														: "The agent is waiting for your answer"}
													{owner(value.channel) && ` · ${owner(value.channel)}’s channel`}
												</span>
											</span>
										</button>
									</li>
								)
						)}
					</ul>
				</Section>
			)}
			{project.repo && (
				<Section
					title="Pick back up"
					action={
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Refresh from GitHub"
							disabled={github.some((query) => query.loading)}
							onClick={() => github.forEach((query) => query.refresh())}
						>
							<IconRotate
								className={github.some((query) => query.loading) ? "animate-spin" : ""}
								aria-hidden
							/>
						</Button>
					}
				>
					{work.length
						? (
							<ul className="flex flex-col gap-1">
								{work.map((value) => (
									<WorkRow
										key={value.item.url}
										work={value}
										owner={owner(value.channel)}
										busy={busy || !connected}
										onChannel={onChannel}
										onStart={creatable ? (item) => void open(item) : undefined}
									/>
								))}
							</ul>
						)
						: (
							<p className="text-sm text-muted-foreground" role="status">
								{github.find((query) => query.error)?.error
									|| (github.some((query) => query.value === undefined)
										? "Loading from GitHub…"
										: "None of your pull requests or assigned issues are open.")}
							</p>
						)}
				</Section>
			)}
			{team.length > 0 && (
				<Section title="Team pulse">
					<ul className="flex flex-col gap-1">
						{team.map((teammate) => (
							<TeammateRow key={teammate.login} teammate={teammate} onChannel={onChannel} />
						))}
					</ul>
				</Section>
			)}
			<section className="mx-auto mt-10 max-w-[39rem]">
				<div className="mb-3 flex items-center justify-between gap-3">
					<h2 className="text-sm font-medium">Channels</h2>
					{creatable && (
						<Button
							size="sm"
							variant="ghost"
							disabled={!connected || busy}
							onClick={() => void start()}
						>
							<IconPlus className="size-3.5" aria-hidden />
							New channel
						</Button>
					)}
				</div>
				{active.length
					? (
						<div className="flex flex-col gap-1">
							{active.map((channel) => (
								<button
									key={channel.id}
									onClick={() => onChannel(channel)}
									className="flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/30"
								>
									{channel.compute
										? (
											<IconCloud
												className="size-4 shrink-0 text-muted-foreground"
												aria-label="Cloud channel"
											/>
										)
										: channel.hosted
										? (
											<IconGlobe
												className="size-4 shrink-0 text-muted-foreground"
												aria-label="Hosted channel"
											/>
										)
										: <IconHash className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
									<span className="min-w-0 flex-1">
										<span className="block truncate">{channel.name}</span>
										{channel.summary && (
											<span className="mt-1 line-clamp-2 text-xs leading-5 break-words text-muted-foreground">
												{channel.summary}
											</span>
										)}
									</span>
									{channel.state === "offline" && (
										<Tooltip>
											<TooltipTrigger
												render={<span className="text-xs text-muted-foreground" />}
											>
												Offline<span className="sr-only">: {channel.host} is unreachable</span>
											</TooltipTrigger>
											<TooltipContent>{channel.host} is unreachable</TooltipContent>
										</Tooltip>
									)}
								</button>
							))}
						</div>
					)
					: (
						<p className="text-sm text-muted-foreground">
							Your channels in this project will appear here.
						</p>
					)}
			</section>
		</div>
	);
}
