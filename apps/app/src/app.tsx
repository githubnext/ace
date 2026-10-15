import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
	Button,
	Layout,
	Main,
	SessionSidebar,
	type SessionSidebarGroup,
	type SessionSidebarGroupId,
	type SessionSidebarProps,
	type SessionSidebarRepo,
	Sidebar,
	type SidebarRow,
	ThemeProvider,
	toast,
	Toaster,
	TooltipProvider,
	useLayoutLeft,
	useLayoutRight,
	useLocalStorage,
	useMedia,
} from "@ace/ui";
import { IconHash, IconPlus } from "@ace/ui/icons";
import {
	type Hello,
	type HostRequest,
	isInactive,
	type Listing,
	type MoveTarget,
	type People,
	type Project,
} from "@ace/host/protocol";

import { chosen, deployed, remember } from "./address";
import { glow, type Outcome, useAttention } from "./attention";
import { Channel, ChannelDetails, type ChannelDraft } from "./channel";
import { Dashboard } from "./dashboard";
import { DeleteChannel } from "./delete-channel";
import { Github, GithubSidebar } from "./github";
import { useGithubRefresh } from "./github-cache";
import { desktop, here, titlebar } from "./desktop";
import { host } from "./host";
import { Rename } from "./layout/rename";
import { MoveChannel } from "./move-channel";
import { Navigation, type Page, WindowControls } from "./navigation";
import { EmptyProjects, InitGit, OpenProject } from "./open-project";
import { Palette } from "./palette";
import {
	type AppProject,
	channelProject,
	checkoutId,
	label,
	projectId,
	projects,
} from "./projects";
import { Settings } from "./settings";
import { SetupProject } from "./setup-project";
import { UpdateNotice } from "./updates";
import { useWindowStorage } from "./window-storage";

// Older versions saved an inline GitHub item per project; Ace now opens items on GitHub.
localStorage.removeItem(`ace:github-targets:${host.url}`);

/**
 * On a phone the channel list is a drawer over the channel: open while no channel is chosen, and
 * out of the way once one is.
 */
function Drawers({ page, channel }: { page: string; channel?: string }) {
	const left = useLayoutLeft();
	const { setOpen: setRightOpen } = useLayoutRight();
	const phone = useMedia("(width < 40rem)");
	const { setOpen } = left;
	useEffect(() => {
		if (phone) setOpen(page === "channels" && !channel);
	}, [phone, page, channel, setOpen]);
	useEffect(() => {
		if (page !== "channels" || !channel) setRightOpen(false);
	}, [page, channel, setRightOpen]);
	return null;
}

function ChannelsSidebar(props: SessionSidebarProps) {
	const left = useLayoutLeft();
	const right = useLayoutRight();
	const phone = useMedia("(width < 40rem)");
	return (
		<SessionSidebar
			{...props}
			onInfo={(item) => {
				props.onSelect?.(item);
				if (phone) left.setOpen(false);
				right.setOpen(true);
			}}
		/>
	);
}

function Disconnected() {
	if (desktop) return <>Disconnected from Ace Helper. Open Settings → This Mac to start it.</>;
	if (!deployed) return <>Disconnected from your host. Reconnecting…</>;
	return (
		<>
			Can't reach {chosen}. Check that Tailscale is on.{" "}
			<button
				type="button"
				className="underline underline-offset-2"
				onClick={() => {
					remember(undefined);
					location.reload();
				}}
			>
				Change host
			</button>
		</>
	);
}

const ALL_PROJECTS = "all";
const RECENT_CHANNELS = 10;

function row(channel: Listing, user: string, host: string, outcome?: Outcome): SidebarRow {
	return {
		uid: channel.id,
		kind: "session",
		name: channel.name,
		summary: channel.summary,
		createdAt: Math.floor(channel.created / 1000),
		lifecycle: channel.state === "archived" ? "archived" : "live",
		private: false,
		hosted: !!channel.hosted,
		mine: channel.owner === user,
		member: true,
		capabilities: {
			rename: channel.owner === user && channel.state !== "offline",
			archive: channel.host === host,
			delete: channel.host === host,
			move: channel.owner === user && channel.host === host && channel.state !== "archived",
		},
		connection: channel.state === "running"
			? "connected"
			: channel.state === "offline"
			? "offline"
			: "idle",
		host: channel.host,
		agent: channel.state === "running" && channel.busy ? "thinking" : "idle",
		unreadCount: outcome === "done" ? 1 : 0,
		needsAttention: outcome === "failed",
		mentionCount: 0,
		lastActivityAt: Math.floor((channel.active || channel.created) / 1000),
		online: [],
	};
}

/** Teammates appear by GitHub login where their host knows it. */
const person = (people: People, owner: string) => people[owner] || owner;

/** A teammate's section says when none of its channels can open because their hosts are unreachable. */
function heading(label: string, rows: SidebarRow[]) {
	return rows.length > 0 && rows.every((value) => value.connection === "offline")
		? `${label} · Offline`
		: label;
}

/** Pins belong to the person, not the channel, so teammates never see them. */
function pinnedGroup(
	channels: Listing[],
	pins: string[],
	hello: Hello,
	collapsed: Partial<Record<SessionSidebarGroupId, boolean>>,
	attention: Map<string, Outcome>,
): SessionSidebarGroup {
	const rows = pins.flatMap((id) => {
		const channel = channels.find((value) => value.id === id && value.state !== "archived");
		return channel ? [row(channel, hello.user, hello.host, attention.get(id))] : [];
	});
	return { id: "pinned", label: "Pinned", rows, collapsed: collapsed.pinned };
}

/** Teammates' archived channels stay folded until someone opens them. */
const folded = (
	collapsed: Partial<Record<SessionSidebarGroupId, boolean>>,
	id: SessionSidebarGroupId,
) => collapsed[id] ?? id.endsWith(":archived");

/**
 * A teammate is one participant on every host, so their machines share one section, which keeps
 * their archived channels; only they can archive or delete them. Inactive channels from every
 * host and owner share one group until their transcripts grow again.
 */
function projectGroups(
	channels: Listing[],
	hello: Hello,
	people: People,
	now: number,
	collapsed: Partial<Record<SessionSidebarGroupId, boolean>>,
	attention: Map<string, Outcome>,
	pins: string[],
): SessionSidebarGroup[] {
	const mine: SidebarRow[] = [];
	const inactive: SidebarRow[] = [];
	const archived: SidebarRow[] = [];
	const team = new Map<string, { name: string; rows: SidebarRow[]; archived: SidebarRow[] }>();
	for (const channel of channels) {
		const next = row(channel, hello.user, hello.host, attention.get(channel.id));
		const stored = channel.state === "archived";
		if (!stored && pins.includes(channel.id)) continue;
		if (!stored && isInactive(channel, now)) {
			inactive.push(next);
			continue;
		}
		if (channel.owner === hello.user) {
			(stored ? archived : mine).push(next);
			continue;
		}
		let owned = team.get(channel.owner);
		if (!owned) {
			owned = { name: person(people, channel.owner), rows: [], archived: [] };
			team.set(channel.owner, owned);
		}
		(stored ? owned.archived : owned.rows).push(next);
	}
	return [
		pinnedGroup(channels, pins, hello, collapsed, attention),
		{ id: "mine", label: "Channels", rows: mine, collapsed: collapsed.mine },
		...[...team].sort(([, a], [, b]) => a.name.localeCompare(b.name)).flatMap((
			[owner, { name, rows, archived }],
		): SessionSidebarGroup[] => {
			const id: SessionSidebarGroupId = `team:${owner}`;
			const stored: SessionSidebarGroupId = `team:${owner}:archived`;
			return [
				{ id, label: heading(name, rows), rows, collapsed: folded(collapsed, id) },
				{
					id: stored,
					label: `${name} · Archived`,
					rows: archived,
					collapsed: folded(collapsed, stored),
				},
			];
		}),
		{ id: "inactive", label: "Inactive", rows: inactive, collapsed: collapsed.inactive },
		{ id: "archived", label: "Archived", rows: archived, collapsed: collapsed.archived },
	];
}

export function App() {
	const channels = useSyncExternalStore(host.subscribe, () => host.channels);
	const opened = useSyncExternalStore(host.subscribe, () => host.projects);
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const people = useSyncExternalStore(host.subscribe, () => host.people);
	const [hello, setHello] = useState<Hello>({ user: "", host: "" });
	const [page, setPage] = useWindowStorage<Page>("ace:page", "dashboard");
	const [project, setProject] = useWindowStorage<string | undefined>("ace:project-id", undefined);
	const [all, setAll] = useWindowStorage("ace:all-projects", false);
	const [selected, setSelected] = useWindowStorage<Record<string, string>>(
		"ace:project-channels",
		{},
	);
	const [adding, setAdding] = useState(false);
	/** A project to clone here; `start` continues into channel creation with its initial text. */
	const [setup, setSetup] = useState<{
		project: AppProject & { repo: string };
		start?: { text?: string; onCreated?: () => void };
	}>();
	const [settings, setSettings] = useState<boolean | "updates">(false);
	const [draft, setDraft] = useState<ChannelDraft>();
	const [renaming, setRenaming] = useState<{ id: string; name: string }>();
	const [deleting, setDeleting] = useState<{ id: string; name: string }>();
	const [moving, setMoving] = useState<{ item: SidebarRow; target: MoveTarget }>();
	const [left, setLeft] = useLocalStorage("panel:left", true);
	const [width, setWidth] = useLocalStorage("panel:left:width", 200);
	const [pins, setPins] = useLocalStorage<string[]>("ace:pinned-channels", []);
	const [collapsed, setCollapsed] = useState<Record<SessionSidebarGroupId, boolean>>({
		pinned: false,
		mine: false,
		team: false,
		inactive: true,
		archived: true,
	});
	const [now, setNow] = useState(Date.now);
	const picking = useRef(false);
	const creating = useRef(false);
	useEffect(() => {
		const open = () => setSettings("updates");
		window.addEventListener("ace:updates", open);
		if (location.hash === "#updates") {
			history.replaceState(null, "", location.pathname + location.search);
			open();
		}
		return () => window.removeEventListener("ace:updates", open);
	}, []);

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 60_000);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		if (status !== "open") return;
		host.request<Hello>({ op: "hello" }).then(setHello, () => {});
	}, [status]);

	const available = useMemo(() => projects(opened, channels, hello.host), [
		opened,
		channels,
		hello.host,
	]);
	useGithubRefresh(available);
	const allProjects = all && page === "channels";
	const listings = new Map(channels.map((channel) => [channel.id, channel]));
	const byId = useMemo(() => {
		const values = new Map<string, AppProject>();
		for (const value of available) {
			// Earlier versions saved checkout IDs for project and channel selections.
			for (const checkout of value.checkouts) values.set(checkout, value);
			values.set(value.id, value);
		}
		return values;
	}, [available]);
	const current = (project && byId.get(project)) || available[0];
	const visible = current
		? channels.filter((channel) => channelProject(channel) === current.id)
		: [];
	// The saved checkout ID names the selection an earlier version made among merged checkouts.
	// All Projects shares this selection, so switching views keeps the open channel.
	const channel = current && [
		current.id,
		project,
		...current.checkouts,
	].map((id) => id ? listings.get(selected[id]) : undefined).find((value) =>
		value && channelProject(value) === current.id
	);
	const connected = status === "open" && !!hello.host;
	const local = current?.host === hello.host;
	const needsGit = local && current?.git === false;
	// GitHub projects can be cloned here; other folders exist only on the hosts that hold them.
	const creatable = (local && !needsGit) || !!current?.repo;
	const repos: SessionSidebarRepo[] = [
		{
			id: ALL_PROJECTS,
			name: "All Projects",
			org: "",
			kind: "all",
		},
		...available.map((value) => ({
			id: value.id,
			name: label(value, hello.host),
			org: value.repo?.split("/")[0] || "",
		})),
	];
	const { attention, pulse } = useAttention(
		channels,
		hello.user,
		page === "channels" ? channel?.id : undefined,
	);
	let groups = projectGroups(visible, hello, people, now, collapsed, attention, pins);

	if (allProjects) {
		const byProject = new Map<string, Listing[]>();
		for (const value of channels) {
			if (value.state === "archived" || pins.includes(value.id)) continue;
			const id = channelProject(value);
			const rows = byProject.get(id);
			if (rows) rows.push(value);
			else byProject.set(id, [value]);
		}
		// Like a project's own view, teammates' channels sit under their name, after the project's.
		groups = available.flatMap((value): SessionSidebarGroup[] => {
			const id: SessionSidebarGroupId = `project:${value.id}`;
			const name = label(value, hello.host);
			const mine: SidebarRow[] = [];
			const team = new Map<string, SidebarRow[]>();
			const recent = (byProject.get(value.id) || []).sort((a, b) =>
				(b.active || b.created) - (a.active || a.created)
				|| b.created - a.created || b.id.localeCompare(a.id)
			).slice(0, RECENT_CHANNELS);
			for (const channel of recent) {
				const next = row(channel, hello.user, hello.host, attention.get(channel.id));
				if (channel.owner === hello.user) {
					mine.push(next);
					continue;
				}
				const rows = team.get(channel.owner);
				if (rows) rows.push(next);
				else team.set(channel.owner, [next]);
			}
			return [
				{
					id,
					label: name,
					rows: mine,
					sort: "none",
					collapsed: collapsed[id],
					onNewSession: connected && (value.host === hello.host || value.repo)
						? () => void create(undefined, undefined, value)
						: undefined,
				},
				...[...team].map(([owner, rows]) => ({ owner, name: person(people, owner), rows }))
					.sort((a, b) => a.name.localeCompare(b.name))
					.map(({ owner, name: teammate, rows }): SessionSidebarGroup => {
						const group: SessionSidebarGroupId = `${id}:team:${owner}`;
						return {
							id: group,
							label: heading(`${name} · ${teammate}`, rows),
							rows,
							sort: "none",
							collapsed: collapsed[group],
						};
					}),
			];
		});
		groups.unshift(pinnedGroup(channels, pins, hello, collapsed, attention));
	}

	function chooseProject(id: string) {
		setAll(id === ALL_PROJECTS);
		if (id === ALL_PROJECTS) return setPage("channels");
		setProject(id);
	}

	function select(value: Pick<Listing, "id" | "host" | "project" | "root" | "repo">) {
		const id = channelProject(value);
		setProject(id);
		if (!allProjects) setAll(false);
		setSelected((previous) => ({ ...previous, [id]: value.id }));
		setPage("channels");
	}

	async function open(path: string) {
		const value = await host.request<Project>({ op: "project-open", path });
		chooseProject(projectId(hello.host, value.path, value.repo));
	}

	async function choose() {
		if (!connected || picking.current) return;
		if (!desktop) return setAdding(true);
		picking.current = true;
		try {
			const path = await desktop.project();
			if (path) await open(path);
		} catch (error) {
			toast.error("Could not open project", { description: (error as Error).message });
		} finally {
			picking.current = false;
		}
	}

	async function init(path: string) {
		try {
			await host.request<Project>({ op: "project-init", path });
		} catch (error) {
			toast.error("Could not initialize Git", { description: (error as Error).message });
		}
	}

	function startSetup(project: AppProject, start?: { text?: string; onCreated?: () => void }) {
		if (project.repo) setSetup({ project: { ...project, repo: project.repo }, start });
	}

	/** Channels only start on this host; setup may clone here first, never on the other host. */
	async function finishSetup(path: string) {
		if (!setup) return;
		const value = await host.request<Project>({
			op: "project-clone",
			repo: setup.project.repo,
			path,
		});
		const id = projectId(hello.host, value.path, value.repo);
		setSetup(undefined);
		if (!setup.start) return chooseProject(id);
		const target: AppProject = {
			...value,
			id,
			host: hello.host,
			reachable: true,
			hosts: new Set([hello.host]),
			checkouts: new Set([checkoutId(hello.host, value.path)]),
		};
		await create(setup.start.text, setup.start.onCreated, target);
	}

	async function create(
		text?: string,
		onCreated?: () => void,
		target = current,
	): Promise<void> {
		if (!target || !connected || creating.current) return;
		if (target.host !== hello.host) return startSetup(target, { text, onCreated });
		creating.current = true;
		try {
			const value = await host.request<Pick<Listing, "id" | "project">>({
				op: "create",
				project: target.path,
			});
			if (text) {
				try {
					await host.channel(value.id, { op: "ask", author: hello.user, text });
				} catch (error) {
					setDraft({ channel: value.id, text });
					toast.error("Could not invoke agent", {
						description: (error as Error).message,
						action: { label: "Settings", onClick: () => setSettings(true) },
					});
				}
			}
			onCreated?.();
			select({ ...value, host: hello.host, root: target.path, repo: target.repo });
		} catch (error) {
			toast.error("Could not start channel", {
				description: (error as Error).message,
				action: { label: "Settings", onClick: () => setSettings(true) },
			});
		} finally {
			creating.current = false;
		}
	}

	async function change(request: HostRequest) {
		try {
			await host.request(request);
		} catch (error) {
			toast.error("Could not update channel", { description: (error as Error).message });
		}
	}

	async function archiveInactive(project: string) {
		try {
			const count = await host.request<number>({ op: "archive-inactive", project });
			const now = Date.now();
			const elsewhere = visible.some((channel) =>
				channel.host !== hello.host && channel.state !== "archived" && isInactive(channel, now)
			);
			toast(
				count
					? `Archived ${count} inactive channel${count === 1 ? "" : "s"}`
					: "No inactive channels on this host",
				elsewhere
					? {
						description: "Inactive channels on other hosts stay until their owners archive them.",
					}
					: undefined,
			);
		} catch (error) {
			toast.error("Could not archive channels", { description: (error as Error).message });
		}
	}

	function moveTargets(item: SidebarRow) {
		return host.request<MoveTarget[]>({ op: "move-targets", channel: item.uid });
	}

	async function move(item: SidebarRow, target: MoveTarget) {
		const title = `Moving ${item.name} to ${target.label}…`;
		const id = toast.loading(title);
		try {
			await host.move(
				item.uid,
				target.target,
				(waiting) => toast.loading(title, { id, description: waiting ?? undefined }),
			);
			toast.success(`Moved ${item.name} to ${target.label}`, { id, description: undefined });
		} catch (error) {
			// A move can fail minutes after it started, so the reason stays until it is dismissed.
			toast.error(`Could not move ${item.name}`, {
				id,
				description: (error as Error).message,
				duration: Infinity,
				action: { label: "Try again", onClick: () => void move(item, target) },
			});
		}
	}

	async function rename(name: string) {
		if (!renaming) return;
		await host.channel(renaming.id, { op: "rename", author: hello.user, name: name.trim() });
		setRenaming(undefined);
	}

	return (
		<ThemeProvider storageKey="ace-theme">
			<TooltipProvider>
				<Layout
					appearance={desktop ? "native" : "web"}
					defaultNavOpen={false}
					leftOpen={left}
					onLeftChange={setLeft}
					leftWidth={width}
					onLeftWidthChange={setWidth}
					loading={status === "connecting" || pulse === "on"}
					{...(pulse && glow.props)}
					onDoubleClick={titlebar}
					nav={
						<Navigation
							page={page}
							user={hello.user}
							github={people[hello.user]}
							onPage={setPage}
							onSettings={() => setSettings(true)}
						/>
					}
				>
					<Drawers page={page} channel={channel?.id} />
					<WindowControls
						onOpen={() => void choose()}
						onSettings={() => setSettings(true)}
						onPage={setPage}
						connected={connected}
					/>
					{page !== "dashboard" && current && (
						<Sidebar
							side="left"
							id="sidebar"
							className="-my-2 h-[calc(100%+1rem)]"
							innerClassName="h-full min-h-0"
						>
							{page === "channels"
								? (
									<ChannelsSidebar
										className="min-h-0 w-full min-w-0 flex-1 bg-transparent"
										projectName={allProjects ? "All Projects" : current.name}
										repos={repos}
										selectedRepoId={allProjects ? ALL_PROJECTS : current.id}
										groups={groups}
										selectedUid={channel?.id}
										loading={status === "connecting" && !channels.length}
										onRepoChange={(repo) => chooseProject(repo.id)}
										onAddRepo={connected ? () => void choose() : undefined}
										onSelect={(item) => {
											const value = listings.get(item.uid);
											if (value) select(value);
										}}
										onNewSession={!allProjects && creatable && connected
											? () => void create()
											: undefined}
										onRename={connected
											? (item) => setRenaming({ id: item.uid, name: item.name })
											: undefined}
										onMoveTargets={connected && !deployed ? moveTargets : undefined}
										onMove={connected && !deployed
											? async (item, target) => setMoving({ item, target })
											: undefined}
										onPin={(item) => setPins((value) => [...value, item.uid])}
										onUnpin={(item) => setPins((value) => value.filter((id) => id !== item.uid))}
										onToggleGroup={(id) =>
											setCollapsed((value) => ({ ...value, [id]: !folded(value, id) }))}
										onArchive={(allProjects || local) && connected
											? (item) =>
												void change({
													op: "archive",
													channel: item.uid,
													archived: item.lifecycle !== "archived",
												})
											: undefined}
										onArchiveInactive={!allProjects && local && connected
											? () => void archiveInactive(current.path)
											: undefined}
										onDelete={!allProjects && local && connected
											? (item) => setDeleting({ id: item.uid, name: item.name })
											: undefined}
										empty={
											<p className="px-4 py-6 text-xs text-muted-foreground">
												{allProjects
													? "No recent channels across your projects."
													: "No channels in this project yet."}
											</p>
										}
									/>
								)
								: (
									<GithubSidebar
										kind={page}
										project={current}
										repos={repos}
										connected={connected}
										onProject={chooseProject}
										onOpen={() => void choose()}
									/>
								)}
						</Sidebar>
					)}
					<Main
						className={(page === "channels" && channel) || page === "issues" || page === "prs"
							? "overflow-hidden bg-background"
							: "overflow-y-auto bg-background"}
					>
						{deployed && status === "connecting" && !channels.length && (
							<p role="status" className="border-b px-4 py-2 text-xs text-muted-foreground">
								Connecting to{" "}
								{chosen}… If your browser asks to reach devices on your local network, allow it.
							</p>
						)}
						{status === "closed" && (
							<p role="status" className="border-b px-4 py-2 text-xs text-muted-foreground">
								<Disconnected />
							</p>
						)}
						{!current && !connected
							? null
							: !current
							? <EmptyProjects onOpen={() => void choose()} disabled={!connected} />
							: page === "dashboard"
							? (
								<Dashboard
									key={current.id}
									project={current}
									repos={repos}
									channels={visible}
									local={local}
									connected={connected}
									onSetup={!local && current.repo ? () => startSetup(current) : undefined}
									onInit={() => init(current.path)}
									onProject={chooseProject}
									onOpen={() => void choose()}
									onChannel={select}
									onCreate={create}
								/>
							)
							: page === "issues" || page === "prs"
							? (
								<Github
									key={`${current.id}:${page}`}
									kind={page}
									project={current}
									connected={connected}
									onCreate={creatable ? create : undefined}
								/>
							)
							: channel
							? (
								<Channel
									key={channel.id}
									channel={channel}
									channels={channels}
									user={hello.user}
									remote={channel.host !== hello.host}
									draft={draft}
									onDraftLoaded={() => setDraft(undefined)}
									onSettings={() => setSettings(true)}
									onOpen={select}
								/>
							)
							: (
								<div className="flex min-h-full flex-col items-center justify-center gap-4 px-5 py-10 text-center">
									<IconHash className="size-6 text-muted-foreground" aria-hidden />
									<h1 className="text-base font-medium">
										{allProjects
											? "Choose a channel from any project"
											: `Choose a channel in ${current.name}`}
									</h1>
									{allProjects && (
										<p className="text-sm text-muted-foreground">
											Use + beside a project to start a new channel.
										</p>
									)}
									{!allProjects && !local && (
										<p className="max-w-[34rem] text-sm text-muted-foreground">
											{current.name} is checked out on {[...current.hosts].join(", ")}.{" "}
											{current.repo
												? `Set it up on ${here} to start channels here.`
												: "Open a checkout on this host to start channels here."}
										</p>
									)}
									{!allProjects && needsGit && (
										<div className="w-full max-w-[34rem]">
											<InitGit
												name={current.name}
												disabled={!connected}
												onInit={() => init(current.path)}
											/>
										</div>
									)}
									{!allProjects && creatable && (
										<div className="flex gap-2">
											{!local && (
												<Button
													variant="outline"
													disabled={!connected}
													onClick={() => startSetup(current)}
												>
													Set up on {here}
												</Button>
											)}
											<Button disabled={!connected} onClick={() => void create()}>
												<IconPlus aria-hidden />New channel
											</Button>
										</div>
									)}
								</div>
							)}
					</Main>
					{page === "channels" && channel && <ChannelDetails channel={channel} />}
				</Layout>
				<Palette
					channels={channels}
					projects={available}
					host={hello.host}
					project={current?.id}
					attention={attention}
					onChannel={select}
					onCreate={current && creatable && connected
						? { name: current.name, run: () => void create() }
						: undefined}
				/>
				{adding && <OpenProject onOpen={open} onClose={() => setAdding(false)} />}
				{setup && (
					<SetupProject
						project={setup.project}
						starting={!!setup.start}
						onSetup={finishSetup}
						onClose={() => setSetup(undefined)}
					/>
				)}
				{renaming && (
					<Rename
						open
						name={renaming.name}
						title="Rename channel"
						label="Channel name"
						description="Use lowercase letters, numbers, and hyphens, up to 63 characters."
						maxLength={63}
						pattern="[a-z0-9][a-z0-9\-]{0,62}"
						required
						onSave={rename}
						onCancel={() => setRenaming(undefined)}
					/>
				)}
				{deleting && (
					<DeleteChannel
						name={deleting.name}
						onDelete={async () => {
							await change({ op: "delete", channel: deleting.id });
							setDeleting(undefined);
						}}
						onCancel={() => setDeleting(undefined)}
					/>
				)}
				{moving && (
					<MoveChannel
						name={moving.item.name}
						target={moving.target.target}
						label={moving.target.label}
						onMove={() => {
							setMoving(undefined);
							void move(moving.item, moving.target);
						}}
						onCancel={() => setMoving(undefined)}
					/>
				)}
				{settings && (
					<Settings
						key={String(settings)}
						initialSection={settings === "updates" ? "updates" : undefined}
						onClose={() => setSettings(false)}
					/>
				)}
				{desktop && <UpdateNotice onOpen={() => window.dispatchEvent(new Event("ace:updates"))} />}
				<Toaster />
			</TooltipProvider>
		</ThemeProvider>
	);
}
