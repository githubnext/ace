import type { Tabs, Window } from "@ace/channel/tabs";

import { local } from "./loopback";
import type { WindowInfo } from "./protocol";

function window({ id, tabs }: WindowInfo): Window {
	return { id, tabs };
}

/** The gateway holds the window registry and admits it only to the owner's loopback clients. */
export function tabs(channel: string): Tabs {
	return {
		list: async () =>
			(await local<WindowInfo[]>({ op: "windows" }))
				.filter((value) => value.channel.id === channel)
				.map(window),
		rename: async ({ window: id, tab, name }) =>
			window(await local<WindowInfo>({ op: "tab-rename", window: id, channel, tab, name })),
	};
}
