import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type Extension,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import {
	type DesktopAction,
	type DesktopRequest,
	type DesktopResult,
	isDesktopAction,
} from "@githubnext/desktop-tools/protocol";
import { desktopRequest, desktopTools } from "@githubnext/desktop-tools/tools";

// The request/result contract lives in the standalone package; pi tools and durability stay here.
export * from "@githubnext/desktop-tools/protocol";
export type Desktop = (request: DesktopRequest, context: Context) => Promise<DesktopResult>;

export function result(value: DesktopResult): ToolExecutionResult {
	return {
		content: [
			{ type: "text", text: value.text },
			...(value.image ? [{ type: "image" as const, ...value.image }] : []),
		],
		...(value.outcome ? { details: { outcome: value.outcome } } : {}),
		...(value.isError === undefined ? {} : { isError: value.isError }),
	};
}

export function desktop(execute: Desktop): Extension {
	const act = async (request: DesktopAction, api: ToolExecutionApi, context: Context) => {
		api.output(
			"If this desktop action is interrupted, it may have partially run. Inspect the target's current state before retrying. Stopping does not undo input already delivered.",
		);
		// Pi retains committed progress on abort or recovery without replaying the mutation.
		await api.details({ outcome: "unknown" }, context);
		return result(await execute(request, context));
	};
	// Definitions are shared with the standalone app's MCP server; replay and durability stay here.
	return defineExtension({
		name: "ace-desktop",
		sections: [{
			key: "ace-desktop",
			render: async () =>
				[
					"Use desktop_* tools to observe and operate apps on this channel's execution host.",
					"Shell commands remain appropriate for builds, files, and preparing clipboard fixtures directly.",
					"",
					"Do not silently substitute AppleScript, osascript, System Events, or self-built Accessibility or CGEvent programs for desktop tools.",
					"Apple Events can raise a separate macOS Automation prompt for each target app, attributed to Ace; Accessibility and Screen Recording grants do not cover them.",
					"Custom input programs bypass the desktop tools' snapshot and exact-target checks, even when they raise no permission prompt.",
					"Before using a fallback, explain in chat which native tool or capability cannot do the step and why the fallback is needed, including any Automation prompts it can trigger.",
					"Use the user's existing authorization; this guidance adds no separate approval requirement.",
					"",
					"For a refusal before dispatch, follow its concrete recovery hint once when applicable, then refresh the observation; a refusal alone does not prove the capability is missing.",
					"After completed, interrupted, or uncertain input, inspect the current target before deciding whether another action is needed. Never replay input just because its follow-up observation failed.",
				].join("\n"),
		}],
		tools: desktopTools({ place: "this channel's execution host", app: "Ace" }).map((tool) =>
			isDesktopAction({ op: tool.op } as DesktopRequest)
				? defineTool({
					name: tool.name,
					description: tool.description,
					parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
					replay: "unsafe",
					executionMode: "sequential",
					execute: async (args, api, context) =>
						act(desktopRequest(tool, args) as DesktopAction, api, context),
				})
				: defineTool({
					name: tool.name,
					description: tool.description,
					parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
					replay: "safe",
					execute: async (args, _api, context) =>
						result(await execute(desktopRequest(tool, args), context)),
				})
		),
	});
}
