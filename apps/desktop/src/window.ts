import { dirname, join } from "node:path";

import { dlopen } from "bun:ffi";

import type { LiveStatus } from "./protocol";

const { symbols } = dlopen(join(dirname(process.execPath), "ace-window.dylib"), {
	ace_window_setup: { args: ["ptr"], returns: "void" },
	ace_window_lights: { args: ["ptr", "bool"], returns: "void" },
	ace_window_zoom: { args: ["ptr"], returns: "void" },
	ace_live_show: {
		args: ["ptr", "cstring", "u32", "f64", "f64", "f64", "f64"],
		returns: "cstring",
	},
	ace_live_relink: { args: ["cstring", "cstring"], returns: "void" },
	ace_live_hide: { args: ["cstring"], returns: "void" },
});

const text = (value: string) => Buffer.from(value + "\0");

export const windowStyle = {
	setup: symbols.ace_window_setup,
	lights: symbols.ace_window_lights,
	zoom: symbols.ace_window_zoom,
};

export const live = {
	show: (
		window: Parameters<typeof symbols.ace_window_zoom>[0],
		id: string,
		target: number,
		rect: Rect,
	): LiveStatus => {
		const [state, current, app] = symbols.ace_live_show(
			window,
			text(id),
			target,
			rect.x,
			rect.y,
			rect.width,
			rect.height,
		).toString().split(" ");
		return state === "live"
			? { state, window: Number(current), app: app! }
			: { state: state as "wait" | "lost" };
	},
	relink: (id: string, app?: string) => symbols.ace_live_relink(text(id), text(app || "")),
	hide: (id: string) => symbols.ace_live_hide(text(id)),
};

export type Rect = { x: number; y: number; width: number; height: number };
