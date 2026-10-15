import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";

export type Tab = { id: string; name: string; type: string; active: boolean };
/** A local Ace window showing this channel; its tabs are that window's layout, not channel state. */
export type Window = { id: string; tabs: Tab[] };
/** Bound to one channel: only windows showing it are listed or renamed. */
export type Tabs = {
	list(context: Context): Promise<Window[]>;
	rename(request: { window: string; tab: string; name: string }, context: Context): Promise<Window>;
};

/** Ace's own layout, so it is never gated by native desktop tools. */
export function tabs(layout: Tabs): Extension {
	return defineExtension({
		name: "ace-tabs",
		tools: [
			defineTool({
				name: "tabs",
				description:
					"List the tabs of each open Ace app window that is showing this channel on its host, with each window's ID and each tab's ID, name, type, and whether it is selected in its pane. These are Ace's own tabs, not browser or desktop windows, and need no desktop tools.",
				parameters: Type.Object({}, { additionalProperties: false }),
				replay: "safe",
				execute: async (_args, _api, context) => {
					const windows = await layout.list(context);
					const text = windows.length
						? JSON.stringify(windows)
						: "No open Ace window is showing this channel.";
					return { content: [{ type: "text", text }] };
				},
			}),
			defineTool({
				name: "tab_rename",
				description:
					"Rename one tab in an Ace app window showing this channel, using the window and tab IDs from tabs. The label stays in that window's layout; it does not rename the channel or a chat, or change anyone else's view. An empty name restores the tab's default label. The Chat tab follows the channel name; use the channel tool to rename it.",
				parameters: Type.Object({
					window: Type.String({ minLength: 1, maxLength: 64 }),
					tab: Type.String({ minLength: 1, maxLength: 64 }),
					name: Type.String({ maxLength: 80 }),
				}, { additionalProperties: false }),
				replay: "safe",
				execute: async (args, _api, context) => ({
					content: [{ type: "text", text: JSON.stringify(await layout.rename(args, context)) }],
				}),
			}),
		],
	});
}
