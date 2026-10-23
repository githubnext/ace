import { Electroview } from "electrobun/view";
import type { MouseEvent } from "react";

import type {
	CommandAction,
	DesktopRPC,
	HelperAction,
	NativeAction,
	UpdateAction,
} from "@ace/desktop/protocol";

import { nativeToken } from "./host";

const rpc = Electroview.defineRPC<DesktopRPC>({
	// A native folder picker stays open until the person chooses a folder or cancels.
	maxRequestTime: Infinity,
	handlers: { requests: {}, messages: {} },
});

const token = nativeToken;
const view = token ? new Electroview({ rpc }) : undefined;

export const desktop = view && token
	? {
		project: () => rpc.request.project({ token }),
		lights: (expanded: boolean) => rpc.request.lights({ token, expanded }),
		zoom: () => rpc.request.zoom({ token }),
		window: () => rpc.request.window({ token }),
		helper: (action: HelperAction) => rpc.request.helper({ token, action }),
		native: (action: NativeAction) => rpc.request.native({ token, action }),
		updates: (action: UpdateAction) => rpc.request.updates({ token, action }),
		command: (action: CommandAction) => rpc.request.command({ token, action }),
		notify: (title: string, body: string, channel?: string) =>
			rpc.request.notify({ token, title, body, channel }),
	}
	: undefined;

const CONTROL =
	"button,a,input,select,textarea,summary,[contenteditable=true],[role=button],[role=checkbox],[role=menuitem],[role=switch],[aria-haspopup]";

export function titlebar(event: MouseEvent<HTMLElement>) {
	if (!desktop || event.defaultPrevented || event.button !== 0 || event.clientY > 28) return;
	if (!(event.target instanceof Element) || event.target.closest(CONTROL)) return;
	event.preventDefault();
	void desktop.zoom();
}

/** The machine this app's host runs on: the desktop only runs on macOS. */
export const here = desktop ? "this Mac" : "this host";
