export type CommandPaletteModifier = "meta" | "ctrl" | "mod" | "alt" | "shift";

export type CommandPaletteShortcut = {
	key: string;
	modifiers?: CommandPaletteModifier[];
	when?: "native" | "web";
	label?: string;
};

export type CommandPaletteCommandItem = {
	kind: "command";
	id: string;
	label: string;
	group: string;
	shortcut?: CommandPaletteShortcut;
	keywords?: string[];
	disabled?: boolean;
	hiddenUntilSearch?: boolean;
};

export type CommandPaletteSessionStatus = "idle" | "busy" | "unread" | "mention" | "attention";

export type CommandPaletteSessionItem = {
	kind: "session";
	id: string;
	label: string;
	group: string;
	keywords?: string[];
	archived?: boolean;
	status?: CommandPaletteSessionStatus;
	disabled?: boolean;
	hiddenUntilSearch?: boolean;
};

export type CommandPaletteItem = CommandPaletteCommandItem | CommandPaletteSessionItem;

export type CommandPaletteResult = {
	item: CommandPaletteItem;
	value: string;
};
