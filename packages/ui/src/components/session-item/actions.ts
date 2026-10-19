import type { SidebarRow } from "./session-item.types";

export type ActionProps = {
	pinned?: boolean;
	onPin?: (data: SidebarRow) => void;
	onUnpin?: (data: SidebarRow) => void;
	onArchive?: (data: SidebarRow) => void;
};

export function canTogglePin({ pinned, onPin, onUnpin }: ActionProps) {
	return pinned ? Boolean(onUnpin) : Boolean(onPin);
}
