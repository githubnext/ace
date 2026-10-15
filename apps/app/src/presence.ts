import type { SidebarRow } from "@ace/ui";
import type { Presence } from "@ace/host/protocol";

/**
 * Each person once, by GitHub login, in `channel` when given. A person is away only when every
 * host reports them away. `self` is the viewer's GitHub login; they never see themselves here.
 */
export function present(
	presence: Presence[] | undefined,
	self: string | undefined,
	channel?: string,
): SidebarRow["online"] {
	const away = new Map<string, boolean>();
	for (const value of presence || []) {
		if (value.login === self) continue;
		if (channel && !value.channels.includes(channel)) continue;
		away.set(value.login, away.get(value.login) !== false && value.away);
	}
	return [...away]
		.sort(([a, x], [b, y]) => Number(x) - Number(y) || a.localeCompare(b))
		.map(([login, away]) => ({ id: login, name: login, away }));
}
