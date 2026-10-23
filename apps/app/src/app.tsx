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
	channelProject,
	checkoutId,
	type Hello,
	type HostRequest,
	isInactive,
	type Listing,
	type MoveTarget,
	type People,
	type Project,
	projectId,
	type TerminalShell,
} from "@ace/host/protocol";

import { chosen, deployed, gateway, remember } from "./address";
import { type Attention, glow, useAttention } from "./attention";
import { ArchiveChannel } from "./archive-channel";
import { Channel, ChannelDetails, type ChannelDraft } from "./channel";
import { lastModel } from "./composer";
import { useCompute } from "./compute";
import { Dashboard } from "./dashboard";
import { DeleteChannel } from "./delete-channel";
import { Github, GithubSidebar } from "./github";
import { useGithub, useGithubRefresh } from "./github-cache";
import { desktop, here, titlebar } from "./desktop";
import { host, refused } from "./host";
import { type Invite, parse } from "./invite";
import { Rename } from "./layout/rename";
import { MoveChannel } from "./move-channel";
import { Navigation, type Page, WindowControls } from "./navigation";
import { EmptyProjects, InitGit, OpenProject } from "./open-project";
import { Palette } from "./palette";
import { placement } from "./placement";
import { present } from "./presence";
import { type AppProject, label, projects, title } from "./projects";
import { RemoveProject } from "./remove-project";
import { type Section, Settings } from "./settings";
import { SetupProject } from "./setup-project";
import { ShareProject, useCanShare } from "./share-project";
import { TeamAsks } from "./team-asks";
import {
	AddTeammate,
	CREATE_DIRECTORY,
	CreateDirectory,
	DirectoryCard,
	useDirectory,
	Welcome,
} from "./onboarding";
import { TEAM_SETUP, TeamSetup, TeamSetupItem } from "./team-setup";
import { UpdateNotice } from "./updates";
import { useWindowStorage } from "./window-storage";

// Older versions saved an inline GitHub item per project; Ace now opens items on GitHub.
localStorage.removeItem(`ace:github-targets:${host.url}`);

/**
 * On a phone the channel list is a drawer over the channel: open while no channel is chosen, and
 * out of the way once one is. Choosing a project closes it over Issues and PRs.
 */
function Drawers({ page, channel, project }: { page: string; channel?: string; project?: string }) {
	const left = useLayoutLeft();
	const { setOpen: setRightOpen } = useLayoutRight();
	const phone = useMedia("(width < 40rem)");
	const { setOpen } = left;
	useEffect(() => {
		if (phone) setOpen(page === "channels" && !channel);
	}, [phone, page, channel, project, setOpen]);
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

/**
 * Whether the deployed app's host answers HTTP at all. A browser hides why a WebSocket failed, but
 * an opaque no-cors response still proves the host is reachable, so its gateway refused this app.
 */
function useAnswers(): boolean | undefined {
	const [answers, setAnswers] = useState<boolean>();
	useEffect(() => {
		if (!deployed || !gateway) return;
		const url = new URL(gateway.replace(/^ws/, "http"));
		url.pathname = "/";
		fetch(url, { mode: "no-cors", cache: "no-store" }).then(
			() => setAnswers(true),
			() => setAnswers(false),
		);
	}, []);
	return answers;
}

/** Asked again while disconnected: a helper that was down can come back with a new token. */
function useRefused(): Awaited<ReturnType<typeof refused>> {
	const [value, setValue] = useState<Awaited<ReturnType<typeof refused>>>();
	useEffect(() => {
		if (deployed || desktop) return;
		const check = () => void refused().then(setValue);
		check();
		const interval = setInterval(check, 5000);
		return () => clearInterval(interval);
	}, []);
	return value;
}

function Disconnected() {
	const answers = useAnswers();
	const refusal = useRefused();
	if (desktop) return <>Disconnected from Ace Helper. Open Settings → This Mac to start it.</>;
	if (refusal && "other" in refusal) return <>{refusal.other}</>;
	if (refusal) {
		return (
			<>
				This browser isn't signed in to your host. Run <code>{refusal.command} open</code>{" "}
				on that Mac, or open its sign-in link again.
			</>
		);
	}
	if (!deployed) return <>Disconnected from your host. Reconnecting…</>;
	return (
		<>
			{answers
				? (
					<>
						{chosen} refused this web app. On that host, run{" "}
						<code>ace web {location.origin}</code>, then reload.
					</>
				)
				: <>Can't reach {chosen}. Check that Tailscale is on.</>}{" "}
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

function row(
	channel: Listing,
	user: string,
	host: string,
	online: SidebarRow["online"],
	attention?: Attention,
): SidebarRow {
	const outcome = attention?.mark;
	const place = placement(channel);
	// A host's channels are all its owner's, so this is also the host's owner-only check.
	const own = channel.owner === user && channel.host === host;
	return {
		uid: channel.id,
		kind: "session",
		name: channel.name,
		summary: channel.summary,
		createdAt: Math.floor(channel.created / 1000),
		lifecycle: channel.state === "archived" ? "archived" : "live",
		private: false,
		cloud: place.kind === "cloud",
		hosted: place.kind === "hosted",
		mine: channel.owner === user,
		member: true,
		capabilities: {
			rename: channel.owner === user && channel.state !== "offline",
			archive: own,
			delete: own,
			// A cloud compute channel's lanes are in its container, out of the host's reach.
			fork: own && !channel.compute,
			move: own && channel.state !== "archived" && !channel.compute,
			// The applicable action follows the transition's end, so none is offered during it.
			compute: own && !!channel.compute && !channel.computing,
		},
		connection: channel.computing
			? "warming"
			: channel.state === "running"
			? "connected"
			: channel.state === "offline"
			? "offline"
			: "idle",
		host: channel.host,
		stopped: place.kind === "cloud" && place.stopped,
		// A run waiting on a question is still busy, but the row should show it waiting on them.
		agent: channel.state === "running" && channel.busy && outcome !== "question"
			? "thinking"
			: "idle",
		unreadCount: outcome === "done" || outcome === "message" ? 1 : 0,
		needsAttention: outcome === "failed" || outcome === "question" ? outcome : undefined,
		mentionCount: attention?.mentions || 0,
		lastActivityAt: Math.floor((channel.active || channel.created) / 1000),
		online,
	};
}

/** Teammates appear by GitHub login where their host knows it. */
const person = (people: People, owner: string) => people[owner] || owner;

/** A teammate's section says when none of its channels can open because their hosts are unreachable. */
function offline(rows: SidebarRow[]): string | undefined {
	if (rows.length > 0 && rows.every((value) => value.connection === "offline")) return "Offline";
}

/** Pins belong to the person, not the channel, so teammates never see them. */
function pinnedGroup(
	channels: Listing[],
	pins: string[],
	hello: Hello,
	collapsed: Partial<Record<SessionSidebarGroupId, boolean>>,
	attention: Map<string, Attention>,
	online: (channel: Listing) => SidebarRow["online"],
): SessionSidebarGroup {
	const rows = pins.flatMap((id) => {
		const channel = channels.find((value) => value.id === id && value.state !== "archived");
		return channel
			? [row(channel, hello.user, hello.host, online(channel), attention.get(id))]
			: [];
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
	attention: Map<string, Attention>,
	pins: string[],
	online: (channel: Listing) => SidebarRow["online"],
): SessionSidebarGroup[] {
	const mine: SidebarRow[] = [];
	const inactive: SidebarRow[] = [];
	const archived: SidebarRow[] = [];
	const team = new Map<string, { name: string; rows: SidebarRow[]; archived: SidebarRow[] }>();
	for (const channel of channels) {
		const next = row(channel, hello.user, hello.host, online(channel), attention.get(channel.id));
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
		pinnedGroup(channels, pins, hello, collapsed, attention, online),
		{ id: "mine", label: "Channels", rows: mine, collapsed: collapsed.mine },
		...[...team].sort(([, a], [, b]) => a.name.localeCompare(b.name)).flatMap((
			[owner, { name, rows, archived }],
		): SessionSidebarGroup[] => {
			const id: SessionSidebarGroupId = `team:${owner}`;
			const stored: SessionSidebarGroupId = `team:${owner}:archived`;
			return [
				{ id, label: name, note: offline(rows), rows, collapsed: folded(collapsed, id) },
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
	const presence = useSyncExternalStore(host.subscribe, () => host.presence);
	const [hello, setHello] = useState<Hello>({ user: "", host: "" });
	const [saved, setPage] = useWindowStorage<Page>("ace:page", "dashboard");
	const [project, setProject] = useWindowStorage<string | undefined>("ace:project-id", undefined);
	const [all, setAll] = useWindowStorage("ace:all-projects", false);
	const [selected, setSelected] = useWindowStorage<Record<string, string>>(
		"ace:project-channels",
		{},
	);
	const [adding, setAdding] = useState(false);
	/**
	 * A project to clone here, or a repository by URL without one; `start` continues into channel
	 * creation with its initial text.
	 */
	const [setup, setSetup] = useState<{
		project?: AppProject & { repo: string };
		start?: { text?: string; onCreated?: () => void };
	}>();
	const [settings, setSettings] = useState<boolean | Section>(false);
	const [draft, setDraft] = useState<ChannelDraft>();
	const [renaming, setRenaming] = useState<{ id: string; name: string }>();
	const [deleting, setDeleting] = useState<{ id: string; name: string }>();
	const [archiving, setArchiving] = useState<{ id: string; name: string; commands: string[] }>();
	const [sharing, setSharing] = useState(false);
	const [removing, setRemoving] = useState<AppProject>();
	const [askRemove, setAskRemove] = useLocalStorage("ace:remove-project-ask", true);
	const [moving, setMoving] = useState<{ item: SidebarRow; target: MoveTarget }>();
	const [left, setLeft] = useLocalStorage("panel:left", true);
	const [width, setWidth] = useLocalStorage("panel:left:width", 200);
	const [pins, setPins] = useLocalStorage<string[]>("ace:pinned-channels", []);
	// Welcome shows once on first run.
	const [offered, setOffered] = useLocalStorage("ace:team-setup", false);
	// Joining or inviting to a deployed directory, which needs the team secret.
	const [teaming, setTeaming] = useState<boolean | "inviting" | Invite>(false);
	const [returning, setReturning] = useState<Section>();
	const [directoryDialog, setDirectoryDialog] = useState(false);
	const [teammate, setTeammate] = useState(false);
	const [dismissed, setDismissed] = useLocalStorage("ace:directory-card", false);
	const directory = useDirectory();
	const card = !!directory && !directory.url && !dismissed;
	const [collapsed, setCollapsed] = useLocalStorage<Record<SessionSidebarGroupId, boolean>>(
		"ace:collapsed-groups",
		{
			pinned: false,
			mine: false,
			team: false,
			inactive: true,
			archived: true,
		},
	);
	const [now, setNow] = useState(Date.now);
	const picking = useRef(false);
	const creating = useRef(false);
	useEffect(() => {
		const sections = { updates: "updates", helper: "host" } as const;
		const listeners = Object.entries(sections).map(([name, section]) => {
			const open = () => setSettings(section);
			window.addEventListener(`ace:${name}`, open);
			if (location.hash === `#${name}`) {
				history.replaceState(null, "", location.pathname + location.search);
				open();
			}
			return () => window.removeEventListener(`ace:${name}`, open);
		});
		return () => listeners.forEach((remove) => remove());
	}, []);
	useEffect(() => {
		// Opened from a Settings section, closing Team setup returns there.
		const open = (event: Event) => {
			setSettings(false);
			setTeaming(true);
			setReturning((event as CustomEvent<Section | undefined>).detail);
		};
		const invite = () => {
			setSettings(false);
			setTeaming("inviting");
		};
		// The desktop app hands over an invite link it was opened with, as an event or, for a new
		// window, in the hash.
		const join = (link: string) => {
			const invite = parse(link);
			if (!invite) return;
			setSettings(false);
			setTeaming(invite);
		};
		const joining = (event: Event) => join((event as CustomEvent<string>).detail);
		const create = () => {
			setSettings(false);
			setDirectoryDialog(true);
		};
		const add = () => setTeammate(true);
		window.addEventListener(CREATE_DIRECTORY, create);
		window.addEventListener("ace:add-teammate", add);
		window.addEventListener(TEAM_SETUP, open);
		window.addEventListener("ace:team-invite", invite);
		window.addEventListener("ace:join", joining);
		const fragment = new URLSearchParams(location.hash.slice(1)).get("join");
		if (fragment) {
			history.replaceState(null, "", location.pathname + location.search);
			join(fragment);
		}
		return () => {
			window.removeEventListener(CREATE_DIRECTORY, create);
			window.removeEventListener("ace:add-teammate", add);
			window.removeEventListener(TEAM_SETUP, open);
			window.removeEventListener("ace:team-invite", invite);
			window.removeEventListener("ace:join", joining);
		};
	}, []);

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 60_000);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		if (status !== "open") return;
		host.request<Hello>({ op: "hello" }).then(setHello, () => {});
	}, [status]);

	// Until this host names itself and lists its projects, its own channels read as a teammate's.
	const loaded = !!opened && !!hello.host;
	const available = useMemo(
		() => opened && hello.host ? projects(opened, channels, hello.host) : [],
		[opened, channels, hello.host],
	);
	useGithubRefresh(available);
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
	const repo = useGithub<string | null>(
		current && { op: "project-repo", project: current.path, host: current.host },
	);
	// Only a definite answer hides GitHub, so the lists can still say why a lookup failed; Issues and
	// PRs appear once the lookup answers either way, so they never show and then vanish.
	const linked = !!repo.value || (status === "open" && !!repo.error);
	const page = repo.value === null && (saved === "issues" || saved === "prs") ? "channels" : saved;
	function go(next: Page) {
		if (linked || (next !== "issues" && next !== "prs")) return setPage(next);
		// ⌘3, ⌘4, and the menu reach Issues and PRs even where the rail hides them.
		const what = next === "issues" ? "Issues" : "PRs";
		if (!current) return void toast(`${what} need a project on GitHub`);
		if (repo.value === null) {
			toast(`${label(current, hello.host)} isn't on GitHub`, {
				description: `${what} need a project with a GitHub remote.`,
			});
		}
	}
	const allProjects = all && page === "channels";
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
	const { compute } = useCompute();
	const canShare = useCanShare(allProjects ? undefined : current?.id, connected);
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
			title: title(value, hello.host),
			removable: removable(value),
		})),
	];
	const github = people[hello.user];
	const names = useMemo(() => github ? [github.toLowerCase()] : [], [github]);
	const { attention, pulse, seen } = useAttention(
		channels,
		hello.user,
		names,
		page === "channels" ? channel?.id : undefined,
		people,
	);
	// A window that never chose a project, such as one a sign-in link opened, starts at a run that
	// needs you instead of the first project's Dashboard.
	const landed = useRef(false);
	useEffect(() => {
		if (landed.current || project !== undefined || !hello.host) return;
		const waiting = channels.find((value) => {
			const mark = attention.get(value.id)?.mark;
			return mark === "question" || mark === "failed";
		});
		if (!waiting) return;
		landed.current = true;
		select(waiting);
	});
	const online = (channel: Listing) =>
		present(presence[channelProject(channel)], people[hello.user], channel.id);
	let groups = projectGroups(visible, hello, people, now, collapsed, attention, pins, online);
	if (!allProjects && current && removable(current)) {
		groups = groups.map((group) =>
			group.id === "mine" ? { ...group, onRemove: () => remove(current) } : group
		);
	}

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
				const next = row(
					channel,
					hello.user,
					hello.host,
					online(channel),
					attention.get(channel.id),
				);
				if (channel.owner === hello.user) {
					mine.push(next);
					continue;
				}
				const rows = team.get(channel.owner);
				if (rows) rows.push(next);
				else team.set(channel.owner, [next]);
			}
			// A project known only through teammates' channels, such as after removing your copy, shows
			// just their groups; an empty one of yours would read as a project you still have.
			const yours = mine.length > 0 || !!opened?.some((checkout) => isLocal(checkout, value));
			return [
				...(yours
					? [
						{
							id,
							label: name,
							rows: mine,
							sort: "none",
							collapsed: collapsed[id],
							onNewSession: connected && (value.host === hello.host || value.repo)
								? () => void create(undefined, undefined, value)
								: undefined,
							onRemove: removable(value) ? () => remove(value) : undefined,
						} satisfies SessionSidebarGroup,
					]
					: []),
				...[...team].map(([owner, rows]) => ({ owner, name: person(people, owner), rows }))
					.sort((a, b) => a.name.localeCompare(b.name))
					.map(({ owner, name: teammate, rows }): SessionSidebarGroup => {
						const group: SessionSidebarGroupId = `${id}:team:${owner}`;
						return {
							id: group,
							label: name,
							owner: teammate,
							note: offline(rows),
							rows,
							sort: "none",
							collapsed: collapsed[group],
						};
					}),
			];
		});
		groups.unshift(pinnedGroup(channels, pins, hello, collapsed, attention, online));
		// An archived channel says to unarchive it from the sidebar, so All Projects lists yours too.
		const archived = channels.filter((value) =>
			value.state === "archived" && value.owner === hello.user
		).map((value) => row(value, hello.user, hello.host, online(value), attention.get(value.id)));
		groups.push({
			id: "archived",
			label: "Archived",
			rows: archived,
			collapsed: collapsed.archived,
		});
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
		const value = await host.request<Project & { from?: string }>({ op: "project-open", path });
		const id = projectId(hello.host, value.path, value.repo);
		// A GitHub project is one project on this host however many checkouts of it are opened.
		const other = value.repo
			&& opened?.find((checkout) =>
				checkout.path !== value.path && projectId(hello.host, checkout.path, checkout.repo) === id
			);
		chooseProject(id);
		if (other) {
			toast(`${value.name} is already a project at ${other.path}`, {
				description: "Channels in it keep starting from that checkout.",
			});
		} else if (value.from) {
			toast(`Opened ${value.name}`, {
				description:
					`${value.from} is inside the Git repository at ${value.path}, so Ace opened that.`,
			});
		}
	}

	// Declared, not a const: the All Projects groups above call it during render.
	function isLocal(checkout: Project, value: AppProject) {
		return projectId(hello.host, checkout.path, checkout.repo) === value.id;
	}

	// Declared, not a const: the picker and All Projects groups above call it during render.
	function removable(value: AppProject) {
		return connected && !!opened?.some((checkout) => isLocal(checkout, value));
	}

	/** This host's channels in the project, archived ones too, which the host refuses to orphan. */
	function held(value: AppProject) {
		const paths = new Set(
			opened?.flatMap((checkout) => isLocal(checkout, value) ? [checkout.path] : []),
		);
		return channels.filter((channel) => channel.host === hello.host && paths.has(channel.project))
			.length;
	}

	function remove(value: AppProject) {
		if (askRemove || held(value)) setRemoving(value);
		else void forget(value);
	}

	async function forget(value: AppProject) {
		try {
			for (const checkout of opened?.filter((checkout) => isLocal(checkout, value)) || []) {
				await host.request({ op: "project-remove", path: checkout.path });
			}
		} catch (error) {
			toast.error("Could not remove project", { description: (error as Error).message });
		}
	}

	function removeRepo(repo: SessionSidebarRepo) {
		const value = available.find((project) => project.id === repo.id);
		if (value) remove(value);
	}

	/** Opening and cloning go through the host, so a shortcut while disconnected says why it can't. */
	function disconnected(action: string) {
		toast.error(`Can't ${action} while disconnected`, {
			description: desktop
				? "Ace Helper isn't connected. Open Settings → This Mac to start it."
				: "Ace is reconnecting to your host.",
		});
	}

	async function choose() {
		if (!connected) return disconnected("open a folder");
		if (picking.current) return;
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

	async function init(path: string, empty?: boolean) {
		try {
			await host.request<Project>({ op: "project-init", path });
			toast.success(empty ? "Made the first commit" : "Initialized Git", {
				description: "Committed the folder's files as Initial commit. Channels can start here now.",
			});
		} catch (error) {
			toast.error(empty ? "Could not make the first commit" : "Could not initialize Git", {
				description: (error as Error).message,
			});
		}
	}

	function cloneUrl() {
		if (!connected) return disconnected("clone a repository");
		setSetup({});
	}

	function startSetup(project: AppProject, start?: { text?: string; onCreated?: () => void }) {
		if (project.repo) setSetup({ project: { ...project, repo: project.repo }, start });
	}

	/** Channels only start on this host; setup may clone here first, never on the other host. */
	async function finishSetup(repo: string, path: string) {
		if (!setup) return;
		const value = await host.request<Project & { found?: true }>({
			op: "project-clone",
			repo,
			path,
		});
		const id = projectId(hello.host, value.path, value.repo);
		setSetup(undefined);
		if (value.found) toast.success(`Opened the checkout already at ${value.path}`);
		if (!setup.start) return chooseProject(id);
		const target: AppProject = {
			...value,
			id,
			label: value.name,
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
		cloud = false,
	): Promise<void> {
		if (!target || !connected || creating.current) return;
		if (target.host !== hello.host) return startSetup(target, { text, onCreated });
		creating.current = true;
		try {
			const value = await host.request<Pick<Listing, "id" | "name" | "project">>({
				op: "create",
				project: target.path,
				// A cloud channel's models are the compute service's, which this host's pick may lack.
				...(cloud ? { cloud } : { model: lastModel() }),
			});
			if (cloud) {
				onCreated?.();
				select({ ...value, host: hello.host, root: target.path, repo: target.repo });
				return void startCompute(value, text);
			}
			if (text) {
				try {
					await host.channel(value.id, { op: "ask", author: hello.user, text });
				} catch (error) {
					setDraft({ channel: value.id, text });
					toast.error("Could not invoke agent", {
						description: (error as Error).message,
						action: { label: "Providers", onClick: () => setSettings("providers") },
					});
				}
			}
			onCreated?.();
			select({ ...value, host: hello.host, root: target.path, repo: target.repo });
		} catch (error) {
			toast.error("Could not start channel", {
				description: (error as Error).message,
				action: { label: "Settings", onClick: () => setSettings(cloud ? "beta" : true) },
			});
		} finally {
			creating.current = false;
		}
	}

	/** The agent is invoked only once its workspace is connected; a failed start keeps the text. */
	async function startCompute(channel: Pick<Listing, "id" | "name">, text?: string) {
		const title = `Starting ${channel.name} in the cloud…`;
		const id = toast.loading(title);
		try {
			await host.startCompute(
				channel.id,
				(waiting) => toast.loading(title, { id, description: waiting ?? undefined }),
			);
			toast.success(`${channel.name} is running in the cloud`, { id, description: undefined });
		} catch (error) {
			if (text) setDraft({ channel: channel.id, text });
			return toast.error(`Could not start ${channel.name} in the cloud`, {
				id,
				description: (error as Error).message,
				duration: Infinity,
				action: { label: "Try again", onClick: () => void startCompute(channel, text) },
			});
		}
		if (!text) return;
		try {
			await host.channel(channel.id, { op: "ask", author: hello.user, text });
		} catch (error) {
			setDraft({ channel: channel.id, text });
			toast.error("Could not invoke agent", { description: (error as Error).message });
		}
	}

	async function stopCompute(channel: Pick<Listing, "id" | "name">) {
		const id = toast.loading(`Stopping ${channel.name}'s cloud workspace…`, {
			description: "Saving a checkpoint first",
		});
		try {
			await host.request({ op: "compute-stop", channel: channel.id });
			toast.success(`${channel.name}'s cloud workspace stopped`, { id, description: undefined });
		} catch (error) {
			toast.error(`Could not stop ${channel.name}'s cloud workspace`, {
				id,
				description: (error as Error).message,
			});
		}
	}

	async function fork(source: Listing) {
		const id = toast.loading(`Forking ${source.name}…`);
		try {
			const value = await host.request<Pick<Listing, "id" | "name" | "project">>({
				op: "fork",
				channel: source.id,
			});
			toast.success(`Forked ${source.name} into ${value.name}`, { id });
			select({ ...value, host: source.host, root: source.root, repo: source.repo });
		} catch (error) {
			toast.error(`Could not fork ${source.name}`, { id, description: (error as Error).message });
		}
	}

	async function change(request: HostRequest) {
		try {
			await host.request(request);
		} catch (error) {
			toast.error("Could not update channel", { description: (error as Error).message });
		}
	}

	async function archive(id: string, name: string) {
		let shells: TerminalShell[];
		try {
			shells = await host.request<TerminalShell[]>({ op: "terminals", channel: id });
		} catch (error) {
			return toast.error("Could not update channel", { description: (error as Error).message });
		}
		const commands = shells.flatMap((shell) => shell.command ? [shell.command] : []);
		if (commands.length) return setArchiving({ id, name, commands });
		await change({ op: "archive", channel: id, archived: true });
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
							repo={linked || page === "issues" || page === "prs"}
							onPage={go}
							onSettings={() => setSettings(true)}
						/>
					}
				>
					<Drawers page={page} channel={channel?.id} project={current?.id} />
					<WindowControls
						onOpen={() => void choose()}
						onClone={cloneUrl}
						onSettings={() => setSettings(true)}
						onPage={go}
						connected={connected}
					/>
					{page !== "dashboard" && current && (
						<Sidebar
							side="left"
							id="sidebar"
							className="-my-2 h-[calc(100%+1rem)]"
							innerClassName="flex h-full min-h-0 flex-col"
						>
							{page === "channels"
								? (
									<ChannelsSidebar
										className="min-h-0 w-full min-w-0 flex-1 bg-transparent"
										projectName={allProjects ? "All Projects" : current.label}
										here={allProjects
											? undefined
											: present(presence[current.id], people[hello.user])}
										repos={repos}
										selectedRepoId={allProjects ? ALL_PROJECTS : current.id}
										groups={groups}
										selectedUid={channel?.id}
										loading={status === "connecting" && !channels.length}
										onRepoChange={(repo) => chooseProject(repo.id)}
										onRepoRemove={removeRepo}
										onAddRepo={connected ? () => void choose() : undefined}
										onCloneRepo={connected ? cloneUrl : undefined}
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
										onFork={connected
											? (item) => {
												const value = listings.get(item.uid);
												if (value) void fork(value);
											}
											: undefined}
										onPin={(item) => setPins((value) => [...value, item.uid])}
										onUnpin={(item) => setPins((value) => value.filter((id) => id !== item.uid))}
										onToggleGroup={(id) =>
											setCollapsed((value) => ({ ...value, [id]: !folded(value, id) }))}
										onArchive={(allProjects || local) && connected
											? (item) =>
												void (item.lifecycle === "archived"
													? change({ op: "archive", channel: item.uid, archived: false })
													: archive(item.uid, item.name))
											: undefined}
										onArchiveInactive={!allProjects && local && connected
											? () => void archiveInactive(current.path)
											: undefined}
										onShareProject={!allProjects && canShare && connected && directory?.url
											? () => setSharing(true)
											: undefined}
										onCompute={connected
											? (item, action) =>
												void (action === "stop" ? stopCompute : startCompute)({
													id: item.uid,
													name: item.name,
												})
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
										onRemove={removeRepo}
										onOpen={() => void choose()}
										onClone={cloneUrl}
									/>
								)}
							{card && (
								<DirectoryCard
									serving={directory.serving}
									offered={directory.offered}
									onDismiss={() => setDismissed(true)}
									onChange={() => setSettings("team")}
								/>
							)}
							<TeamSetupItem />
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
						{!current && (!connected || !loaded)
							? null
							: !current
							? (
								<EmptyProjects
									onOpen={() => void choose()}
									onClone={cloneUrl}
									disabled={!connected}
								/>
							)
							: page === "dashboard"
							? (
								<Dashboard
									key={current.id}
									project={current}
									repos={repos}
									channels={visible}
									user={hello.user}
									people={people}
									presence={presence[current.id]}
									attention={attention}
									local={local}
									connected={connected}
									onSetup={!local && current.repo ? () => startSetup(current) : undefined}
									onInit={() => init(current.path, current.empty)}
									onProject={chooseProject}
									onRemove={removeRepo}
									onOpen={() => void choose()}
									onClone={cloneUrl}
									onChannel={select}
									onCreate={(text, onCreated, cloud) => create(text, onCreated, current, cloud)}
									onProviders={() => setSettings("providers")}
									cloud={local && !!current.repo && !!compute?.enabled}
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
									seen={seen(channel)}
									draft={draft}
									onDraftLoaded={() => setDraft(undefined)}
									onProviders={() => setSettings("providers")}
									onOpen={select}
								/>
							)
							: (
								<div className="flex min-h-full flex-col items-center justify-center gap-4 px-5 py-10 text-center">
									<IconHash className="size-6 text-muted-foreground" aria-hidden />
									<h1 className="text-base font-medium">
										{allProjects
											? "Choose a channel from any project"
											: `Choose a channel in ${current.label}`}
									</h1>
									{allProjects && (
										<p className="text-sm text-muted-foreground">
											Use + beside a project to start a new channel.
										</p>
									)}
									{!allProjects && !local && (
										<p className="max-w-[34rem] text-sm text-muted-foreground">
											{current.label} isn't on {here} yet. {current.repo
												? "Set it up to start channels here."
												: `Open a checkout of it on ${here} to start channels here.`}
										</p>
									)}
									{!allProjects && needsGit && (
										<div className="w-full max-w-[34rem]">
											<InitGit
												name={current.label}
												empty={current.empty}
												ignored={current.ignored}
												disabled={!connected}
												path={current.path}
												onInit={() => init(current.path, current.empty)}
											/>
										</div>
									)}
									{!allProjects && creatable && (
										<div className="flex gap-2">
											{local
												? (
													<Button
														disabled={!connected}
														onClick={() => void create()}
													>
														<IconPlus aria-hidden />New channel
													</Button>
												)
												: (
													<Button
														disabled={!connected}
														onClick={() => startSetup(current)}
													>
														Set up on {here}
													</Button>
												)}
										</div>
									)}
								</div>
							)}
					</Main>
					{page === "channels" && channel && <ChannelDetails channel={channel} user={hello.user} />}
				</Layout>
				<Palette
					channels={channels}
					projects={available}
					host={hello.host}
					project={current?.id}
					github={linked}
					attention={attention}
					onChannel={select}
					onCreate={current && creatable && connected
						? { name: current.label, run: () => void create() }
						: undefined}
				/>
				{adding && <OpenProject onOpen={open} onClose={() => setAdding(false)} />}
				{setup && (
					<SetupProject
						project={setup.project}
						opened={opened || []}
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
				{sharing && current && (
					<ShareProject
						project={current.id}
						name={label(current, hello.host)}
						user={hello.user}
						channels={visible}
						onClose={() => setSharing(false)}
					/>
				)}
				{removing && (
					<RemoveProject
						name={label(removing, hello.host)}
						path={removing.path}
						channels={held(removing)}
						onRemove={async (ask) => {
							setAskRemove(ask);
							await forget(removing);
							setRemoving(undefined);
						}}
						onCancel={() => setRemoving(undefined)}
					/>
				)}
				{archiving && (
					<ArchiveChannel
						name={archiving.name}
						commands={archiving.commands}
						onArchive={() => {
							setArchiving(undefined);
							void change({ op: "archive", channel: archiving.id, archived: true });
						}}
						onCancel={() => setArchiving(undefined)}
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
						place={moving.target.place}
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
						initialSection={settings === true ? undefined : settings}
						onClose={() => setSettings(false)}
					/>
				)}
				{!offered && connected && !current && (
					<Welcome
						github={hello.github}
						onClose={() => setOffered(true)}
					/>
				)}
				{directoryDialog && (
					<CreateDirectory
						onAdd={() => {
							setDirectoryDialog(false);
							setTeammate(true);
						}}
						onClose={() => setDirectoryDialog(false)}
					/>
				)}
				{teammate && <AddTeammate onClose={() => setTeammate(false)} />}
				{teaming && (
					<TeamSetup
						key={typeof teaming === "object" ? teaming.url : String(teaming)}
						github={hello.github}
						invite={typeof teaming === "object" ? teaming : undefined}
						inviting={teaming === "inviting"}
						onClose={() => {
							setOffered(true);
							setTeaming(false);
							if (returning) setSettings(returning);
						}}
					/>
				)}
				<TeamAsks />
				{desktop && <UpdateNotice onOpen={() => window.dispatchEvent(new Event("ace:updates"))} />}
				<Toaster />
			</TooltipProvider>
		</ThemeProvider>
	);
}
