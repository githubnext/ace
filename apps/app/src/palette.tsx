import { useEffect, useState } from "react";

import {
	CommandPalette,
	type CommandPaletteCommandItem,
	type CommandPaletteItem,
	type CommandPaletteShortcut,
} from "@ace/ui";
import { channelProject, type Listing, type WindowState } from "@ace/host/protocol";

import type { Outcome } from "./attention";
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
	action("prs", "Pull Requests", "Go to", "4"),
	action("project-open", "Open Folder…", "Project", "o"),
	action("project-clone", "Clone from URL…", "Project"),
	action("settings", "Settings", "Ace", ","),
	...(desktop ? [action("updates", "Check for Updates…", "Ace")] : []),
	action("nav-toggle", "Toggle Navigation", "View", "b"),
	action("channels-toggle", "Toggle Channels Sidebar", "View", "b", true),
];

const CREATE = "channel-new";

function channelItems(
	channels: Listing[],
	projects: AppProject[],
	host: string,
	current: string | undefined,
	attention: Map<string, Outcome>,
): CommandPaletteItem[] {
	const names = new Map(projects.map((project) => [project.id, label(project, host)]));
	return channels.map((channel) => {
		const project = channelProject(channel);
		return {
			kind: "session",
			id: `channel:${channel.id}`,
			label: channel.host === host ? channel.name : `${channel.name} · ${channel.host}`,
			group: names.get(project)!,
			keywords: channel.summary ? [channel.summary] : undefined,
			archived: channel.state === "archived",
			// Other projects' channels wait for a search so the current project's stay in reach.
			hiddenUntilSearch: project !== current,
			status: channel.state === "running" && channel.busy
				? "busy"
				: attention.get(channel.id) === "done"
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
export function Palette({ channels, projects, host, project, attention, onChannel, onCreate }: {
	channels: Listing[];
	projects: AppProject[];
	host: string;
	/** The current project's id. */
	project?: string;
	attention: Map<string, Outcome>;
	onChannel: (channel: Listing) => void;
	/** Starts a channel in the current project, when one can start there. */
	onCreate?: { name: string; run: () => void };
}) {
	const [open, setOpen] = useState(false);
	// Tabs are read once on open: they only change through the window the palette covers.
	const [tabs, setTabs] = useState<CommandPaletteItem[]>([]);

	useEffect(() => {
		function key(event: KeyboardEvent) {
			if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return;
			// The composer links and the terminal clears with the same keys while they have focus.
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
		...(onCreate ? [action(CREATE, `New Channel in ${onCreate.name}`, "Channel")] : []),
		...ACTIONS,
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
