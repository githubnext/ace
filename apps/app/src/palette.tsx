import { useEffect, useState } from "react";

import {
	CommandPalette,
	type CommandPaletteCommandItem,
	type CommandPaletteItem,
	type CommandPaletteShortcut,
} from "@ace/ui";
import { channelProject, type Listing, type WindowState } from "@ace/host/protocol";

import type { Attention } from "./attention";
import { desktop } from "./desktop";
import { switcher } from "./layout/layout";
import { type AppProject, label } from "./projects";

function action(
	id: string,
	label: string,
	group: string,
	key?: string,
	shift?: boolean,
): CommandPaletteCommandItem {
	const shortcut: CommandPaletteShortcut | undefined = key
		? { key, modifiers: shift ? ["mod", "shift"] : ["mod"] }
		: undefined;
	return { kind: "command", id, label, group, shortcut };
}

/** Each id is a window action that `WindowControls`, or the app for updates, already handles. */
const ACTIONS = [
	action("dashboard", "Dashboard", "Go to", "1"),
	action("channels", "Channels", "Go to", "2"),
	action("issues", "Issues", "Go to", "3"),
	action("prs", "Pull requests", "Go to", "4"),
	action("project-open", "Open folder…", "Project", "o"),
	action("project-clone", "Clone from URL…", "Project"),
	action("settings", "Settings", "Ace", ","),
	...(desktop ? [action("updates", "Check for updates…", "Ace")] : []),
	action("nav-toggle", "Toggle navigation", "View", "b"),
	action("channels-toggle", "Toggle channels sidebar", "View", "b", true),
];

const CREATE = "channel-new";

function channelItems(
	channels: Listing[],
	projects: AppProject[],
	host: string,
	current: string | undefined,
	attention: Map<string, Attention>,
): CommandPaletteItem[] {
	const names = new Map(projects.map((project) => [project.id, label(project, host)]));
	return channels.map((channel) => {
		const project = channelProject(channel);
		const { mark, mentions } = attention.get(channel.id) || { mentions: 0 };
		return {
			kind: "session",
			id: `channel:${channel.id}`,
			label: channel.host === host ? channel.name : `${channel.name} · ${channel.host}`,
			group: names.get(project)!,
			keywords: channel.summary ? [channel.summary] : undefined,
			archived: channel.state === "archived",
			// Other projects' channels wait for a search so the current project's stay in reach.
			hiddenUntilSearch: project !== current,
			// A run waiting on a question is still busy, but it waits on them, as in the sidebar.
			status: mark === "question" || mark === "failed"
				? "attention"
				: mentions
				? "mention"
				: channel.state === "running" && channel.busy
				? "busy"
				: mark
				? "unread"
				: undefined,
		};
	});
}

function tabItems(window: WindowState): CommandPaletteItem[] {
	return window.tabs.filter((tab) => !tab.active).map((tab) => ({
		kind: "command",
		id: `tab:${tab.id}`,
		// The Chat tab carries the channel's name, which the channel's own item already shows.
		label: tab.type === "chat" ? "Chat" : tab.name,
		group: "Tab",
	}));
}

/** Mod+K searches channels in every project, the open channel's tabs, and window actions. */
export function Palette(
	{ channels, projects, host, project, github, attention, onChannel, onCreate }: {
		channels: Listing[];
		projects: AppProject[];
		host: string;
		/** The current project's id. */
		project?: string;
		/** Whether the current project has a GitHub repository for Issues and Pull requests. */
		github: boolean;
		attention: Map<string, Attention>;
		onChannel: (channel: Listing) => void;
		/** Starts a channel in the current project, when one can start there. */
		onCreate?: { name: string; run: () => void };
	},
) {
	const [open, setOpen] = useState(false);
	// Tabs are read once on open: they only change through the window the palette covers.
	const [tabs, setTabs] = useState<CommandPaletteItem[]>([]);

	useEffect(() => {
		function key(event: KeyboardEvent) {
			if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return;
			// The composer links with the same keys while it has focus.
			if (event.key.toLowerCase() !== "k" || event.defaultPrevented) return;
			event.preventDefault();
			const state = switcher.current?.window();
			setTabs(state ? tabItems(state) : []);
			setOpen((value) => !value);
		}
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, []);

	if (!open) return null;
	const items: CommandPaletteItem[] = [
		...(onCreate ? [action(CREATE, `New channel in ${onCreate.name}`, "Channel")] : []),
		...(github ? ACTIONS : ACTIONS.filter(({ id }) => id !== "issues" && id !== "prs")),
		...tabs,
		...channelItems(channels, projects, host, project, attention),
	];
	const listings = new Map(channels.map((channel) => [`channel:${channel.id}`, channel]));

	function select(item: CommandPaletteItem) {
		const channel = listings.get(item.id);
		if (channel) return onChannel(channel);
		if (item.id.startsWith("tab:")) return switcher.current?.show(item.id.slice("tab:".length));
		if (item.id === CREATE) return onCreate?.run();
		window.dispatchEvent(new Event(`ace:${item.id}`));
	}

	return (
		<CommandPalette
			open
			items={items}
			onOpenChange={setOpen}
			onSelect={select}
			placeholder="Search channels, tabs, and actions…"
			emptyLabel="Nothing matches"
			description="Search channels, tabs, and actions"
		/>
	);
}
