import { homedir } from "node:os";
import { dirname, join } from "node:path";

import Electrobun, { ApplicationMenu, BrowserView, BrowserWindow, Utils } from "electrobun/bun";

import { appUrl, token } from "@ace/host/auth";
import { config, desktop } from "@ace/host/config";

import { command } from "./command";
import { demo } from "./demo";
import { helper as control } from "./helper";
import { native as inspection } from "./native";
import type { DesktopRPC } from "./protocol";
import { updates as updater } from "./updates";
import { live, windowStyle } from "./window";

const resources = join(dirname(process.execPath), "..", "Resources");
const { channel, identifier, version } = await Bun.file(join(resources, "version.json")).json() as {
	channel: string;
	identifier: string;
	version: string;
};
const { profile } = await Bun.file(join(resources, "profile.json")).json() as { profile?: string };
const lane = desktop(identifier, profile);
const helper = control(identifier, !!lane);
const updates = updater(helper, version, channel);
const native = inspection(profile ? `${identifier}.${profile}` : identifier);
const cli = command(
	channel === "stable" ? "ace" : `ace-${channel}`,
	join(dirname(process.execPath), "Ace Helper"),
	join(homedir(), ".local", "bin"),
);
const url = appUrl();
const secret = token();
const windows = new Set<BrowserWindow>();
// Menu actions, the dock, and updates go to the window the person used last.
let focused: BrowserWindow | undefined;
let ready = false;
/** An invite link the app was launched with, held until Ace Helper is up. */
let invited: string | undefined;

function authorize(value: string): void {
	if (value !== secret) throw new Error("Native controls are only available to Ace's local app");
}

// Each window gets its own RPC: a view takes over its RPC's transport, and native window controls
// must act on the window whose page asked.
function controls(target: () => BrowserWindow) {
	return BrowserView.defineRPC<DesktopRPC>({
		handlers: {
			requests: {
				lights: ({ token, expanded }) => {
					authorize(token);
					windowStyle.lights(target().ptr, expanded);
					return null;
				},
				live: ({ token, id, window, rect, relink }) => {
					authorize(token);
					if (window === null || !rect) {
						live.hide(id);
						return null;
					}
					if (relink) live.relink(id, relink.app);
					return live.show(target().ptr, id, window, rect);
				},
				zoom: ({ token }) => {
					authorize(token);
					windowStyle.zoom(target().ptr);
					return null;
				},
				window: ({ token }) => {
					authorize(token);
					open(target());
					return null;
				},
				project: async ({ token }) => {
					authorize(token);
					return native.project(homedir());
				},
				helper: ({ token, action }) => {
					authorize(token);
					if (updates.busy() && ["start", "stop", "restart"].includes(action)) {
						throw new Error("Ace Helper is being managed by the update. Wait for it to finish.");
					}
					return helper.act(action);
				},
				updates: ({ token, action }) => {
					authorize(token);
					return updates.act(action);
				},
				native: ({ token, action }) => {
					authorize(token);
					return native.act(action);
				},
				command: ({ token, action }) => {
					authorize(token);
					// A checkout's build has no Ace Helper of its own; its CLI is bun ace from that checkout.
					if (lane) throw new Error("Use bun ace from this build's checkout.");
					return cli.act(action);
				},
				notify: ({ token, title, body }) => {
					authorize(token);
					Utils.showNotification({ title, body });
					return null;
				},
			},
			messages: {},
		},
	});
}

function dispatch(target: BrowserWindow, action: string): void {
	target.webview.executeJavascript(
		`window.dispatchEvent(new Event(${JSON.stringify(`ace:${action}`)}))`,
	);
}

/** Hands an invite link to the page, which asks before joining. */
function accept(link: string): void {
	if (!ready) {
		invited = link;
		return;
	}
	if (!focused) return open(undefined, `join=${encodeURIComponent(link)}`);
	focused.activate();
	focused.webview.executeJavascript(
		`window.dispatchEvent(new CustomEvent("ace:join", { detail: ${JSON.stringify(link)} }))`,
	);
}

function show(action?: string): void {
	if (!ready) return;
	if (!focused) return open(undefined, action);
	focused.activate();
	if (action) dispatch(focused, action);
}

/** Opens a window, cascaded from `from`. The page seeds its navigation and layout from the profile copy. */
function open(from?: BrowserWindow, action?: string): void {
	const target = new URL(url);
	if (action) target.hash = action;
	const origin = from?.getFrame() || { x: 136, y: 96 };
	const frame = { width: 1100, height: 760, x: origin.x + 24, y: origin.y + 24 };
	const rpc = controls(() => window);
	const view = {
		url: target.href,
		navigationRules: JSON.stringify(["^*", `${url.origin}/*`]),
		rpc,
		preload: `if (window === window.top && location.origin === ${JSON.stringify(url.origin)}) {
			Object.defineProperty(window, "__ACE_TOKEN__", { configurable: true, value: ${
			JSON.stringify(secret)
		} });
			Object.defineProperty(window, "__ACE_DESKTOP__", { configurable: true, value: true });
		}`,
	};
	const window = new BrowserWindow({
		title: "Ace",
		titleBarStyle: "hiddenInset",
		transparent: true,
		...(!lane ? view : {}),
		frame,
	});
	if (lane) {
		// Electrobun 1.18.1 only forwards storage partitions through BrowserView.
		window.webview.remove();
		window.webviewId = new BrowserView({
			...view,
			windowId: window.id,
			partition: `persist:ace-dev-${lane}`,
			frame: { width: frame.width, height: frame.height, x: 0, y: 0 },
		}).id;
	}
	windowStyle.setup(window.ptr);
	window.setWindowButtonPosition(17, 13);
	windowStyle.lights(window.ptr, false);
	windows.add(window);
	focused = window;
	window.on("focus", () => focused = window);
	window.on("close", () => {
		windows.delete(window);
		if (focused === window) focused = [...windows].at(-1);
	});
}

/** The File menu controls a demo host's script; `scripted` is its state, or null without one. */
function menu(scripted: { paused: boolean } | null = null): void {
	ApplicationMenu.setApplicationMenu([
		{
			label: "Ace",
			submenu: [
				{ label: "About Ace", role: "about" },
				{ type: "divider" },
				{ label: "Show Ace", action: "show" },
				{ label: "Settings…", action: "settings", accelerator: "CmdOrCtrl+," },
				{ label: "Check for Updates…", action: "updates" },
				{ type: "divider" },
				{ label: "Start Ace Helper", action: "helper-start" },
				{ label: "Restart Ace Helper", action: "helper-restart" },
				{ label: "Ace Helper Settings…", action: "helper-settings" },
				{ label: "Show Ace Helper Log", action: "helper-log" },
				{ type: "divider" },
				{ label: "Quit Ace", action: "quit", accelerator: "CmdOrCtrl+q" },
			],
		},
		{
			label: "File",
			submenu: [
				{ label: "New Window", action: "new-window", accelerator: "CmdOrCtrl+n" },
				{ label: "Open Folder…", action: "project-open", accelerator: "CmdOrCtrl+o" },
				{ label: "Clone from URL…", action: "project-clone" },
				...(scripted
					? [
						{ type: "divider" as const },
						scripted.paused
							? { label: "Resume Demo", action: "demo-resume" }
							: { label: "Pause Demo", action: "demo-pause" },
						{ label: "Restart Demo", action: "demo-restart" },
					]
					: []),
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "divider" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{ label: "Dashboard", action: "dashboard", accelerator: "CmdOrCtrl+1" },
				{ label: "Channels", action: "channels", accelerator: "CmdOrCtrl+2" },
				{ label: "Issues", action: "issues", accelerator: "CmdOrCtrl+3" },
				{ label: "Pull Requests", action: "prs", accelerator: "CmdOrCtrl+4" },
				{ type: "divider" },
				{ label: "Toggle Navigation", action: "nav-toggle", accelerator: "CmdOrCtrl+b" },
				{
					label: "Toggle Channels Sidebar",
					action: "channels-toggle",
					accelerator: "CmdOrCtrl+Shift+b",
				},
				{ type: "divider" },
				{ label: "Bigger Text", action: "text-bigger", accelerator: "CmdOrCtrl+Plus" },
				{ label: "Smaller Text", action: "text-smaller", accelerator: "CmdOrCtrl+-" },
				{ label: "Actual Size", action: "text-reset", accelerator: "CmdOrCtrl+0" },
			],
		},
		// The collapsed navigation rail hides the minimize and zoom buttons, so the menu keeps both.
		{
			label: "Window",
			submenu: [
				{ role: "minimize", accelerator: "CmdOrCtrl+m" },
				{ role: "zoom" },
				{ role: "toggleFullScreen" },
				{ type: "divider" },
				{ role: "bringAllToFront" },
			],
		},
	]);
}
menu();

Electrobun.events.on("reopen", () => show());
Electrobun.events.on("open-url", ({ data }: { data: { url: string } }) => {
	if (URL.parse(data.url)?.host === "join") accept(data.url);
});
// The webview only navigates within the app; links that open a new window go to the browser.
Electrobun.events.on("new-window-open", ({ data }: { data: { detail: { url: string } } }) => {
	const target = URL.parse(data.detail.url);
	if (!target || !["https:", "http:"].includes(target.protocol) || target.origin === url.origin) {
		return;
	}
	Utils.openExternal(target.href);
});
let quitting = false;
let stopped = false;
Electrobun.events.on("before-quit", (event) => {
	if (ready && updates.busy() && updates.status().phase !== "restarting") {
		event.response = { allow: false };
		show("updates");
		return;
	}
	if (stopped) return;
	event.response = { allow: false };
	if (quitting) return;
	quitting = true;
	void native.stop().catch(console.error).finally(() => {
		stopped = true;
		Utils.quit();
	});
});
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

Electrobun.events.on("application-menu-clicked", ({ data }) => {
	if (data.action === "show") return show();
	if (["demo-pause", "demo-resume", "demo-restart"].includes(data.action)) {
		const action = data.action.slice("demo-".length) as "pause" | "resume" | "restart";
		void demo(action).then(
			menu,
			(error) =>
				Utils.showMessageBox({ type: "error", title: "Demo", message: errorMessage(error) }),
		);
		return;
	}
	// The page shares its navigation and layout before asking for the window, so it opens where the
	// person is.
	if (data.action === "new-window") return focused ? dispatch(focused, "new-window") : show();
	if (data.action === "updates") {
		show("updates");
		if (["idle", "error"].includes(updates.status().phase)) {
			void updates.act({ op: "check" }).catch(() => {});
		}
		return;
	}
	if (
		[
			"settings",
			"project-open",
			"project-clone",
			"dashboard",
			"channels",
			"issues",
			"prs",
			"nav-toggle",
			"channels-toggle",
			"text-bigger",
			"text-smaller",
			"text-reset",
		].includes(
			data.action,
		)
	) {
		return show(data.action);
	}
	if (data.action === "quit") {
		if (!ready || !updates.busy()) return Utils.quit();
		return show("updates");
	}
	// Ace Helper's settings live in Ace; Login Items only matters when macOS asks for approval.
	if (data.action === "helper-settings") return show("helper");
	if (!data.action.startsWith("helper-")) return;
	const action = data.action.slice("helper-".length);
	if (action !== "start" && action !== "restart" && action !== "log") {
		return;
	}
	if (updates.busy() && (action === "start" || action === "restart")) return show("updates");
	void helper.act(action).catch((error) =>
		Utils.showMessageBox({
			type: "error",
			title: "Ace Helper",
			message: errorMessage(error),
		})
	);
});

async function start(): Promise<void> {
	await helper.recover();
	const state = await helper.status();
	if (!state.running) {
		if (lane) {
			throw new Error(
				`This development build has no Ace host on port ${config.port}. Start it with bun run dev from its checkout.`,
			);
		}
		if (state.service === "unregistered") {
			// The bundled macOS dialog renders message but does not display detail.
			const { response } = await Utils.showMessageBox({
				title: "Ace Helper",
				message:
					"Enable Ace Helper?\n\nAce Helper keeps this machine's channels available after you quit Ace and starts when you log in. You can manage it in macOS Login Items.",
				buttons: ["Enable Ace Helper", "Quit"],
				cancelId: 1,
			});
			if (response !== 0) return Utils.quit();
		}
		if (state.service === "approval") {
			const { response } = await Utils.showMessageBox({
				title: "Ace Helper",
				message:
					"Allow Ace Helper to run in the background.\n\nEnable Ace in macOS Login Items, then reopen Ace.",
				buttons: ["Open Login Items", "Quit"],
				cancelId: 1,
			});
			if (response === 0) await helper.act("settings");
			return Utils.quit();
		}
		await helper.act("start");
	}
	ready = true;
	if (invited) accept(invited);
	else show();
	native.start();
	updates.start();
	// Only a host started with `ace demo` runs a script.
	void demo("status").then(menu, () => {});
}

try {
	await start();
} catch (error) {
	await Utils.showMessageBox({
		type: "error",
		title: "Ace Helper",
		message: `Could not connect to Ace Helper.\n\n${errorMessage(error)}`,
	});
	Utils.quit();
}
