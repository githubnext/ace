import { homedir } from "node:os";
import { dirname, join } from "node:path";

import Electrobun, { ApplicationMenu, BrowserView, BrowserWindow, Utils } from "electrobun/bun";

import { appUrl, token } from "@ace/host/auth";
import { config, desktop } from "@ace/host/config";

import { helper as control } from "./helper";
import { native as inspection } from "./native";
import type { DesktopRPC } from "./protocol";
import { updates as updater } from "./updates";
import { windowStyle } from "./window";

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
const url = appUrl();
const secret = token();
let window: BrowserWindow | undefined;
let ready = false;

function authorize(value: string): void {
	if (value !== secret) throw new Error("Native controls are only available to Ace's local app");
}

const rpc = BrowserView.defineRPC<DesktopRPC>({
	handlers: {
		requests: {
			lights: ({ token, expanded }) => {
				authorize(token);
				if (window) windowStyle.lights(window.ptr, expanded);
				return null;
			},
			zoom: ({ token }) => {
				authorize(token);
				if (window) windowStyle.zoom(window.ptr);
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
		},
		messages: {},
	},
});

function show(action?: string): void {
	if (!ready) return;
	if (window) {
		window.focus();
		if (action) {
			window.webview.executeJavascript(
				`window.dispatchEvent(new Event(${JSON.stringify(`ace:${action}`)}))`,
			);
		}
		return;
	}
	const target = new URL(url);
	if (action) target.hash = action;
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
	window = new BrowserWindow({
		title: "Ace",
		titleBarStyle: "hiddenInset",
		transparent: true,
		...(!lane ? view : {}),
		frame: { width: 1100, height: 760, x: 160, y: 120 },
	});
	if (lane) {
		// Electrobun 1.18.1 only forwards storage partitions through BrowserView.
		window.webview.remove();
		window.webviewId = new BrowserView({
			...view,
			windowId: window.id,
			partition: `persist:ace-dev-${lane}`,
			frame: { width: 1100, height: 760, x: 0, y: 0 },
		}).id;
	}
	windowStyle.setup(window.ptr);
	window.setWindowButtonPosition(17, 13);
	windowStyle.lights(window.ptr, false);
	window.on("close", () => window = undefined);
}

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
			{ label: "Open Folder…", action: "project-open", accelerator: "CmdOrCtrl+o" },
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
		],
	},
]);

Electrobun.events.on("reopen", () => show());
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
			"dashboard",
			"channels",
			"issues",
			"prs",
			"nav-toggle",
			"channels-toggle",
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
	if (!data.action.startsWith("helper-")) return;
	const action = data.action.slice("helper-".length);
	if (action !== "start" && action !== "restart" && action !== "settings" && action !== "log") {
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
	show();
	native.start();
	updates.start();
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
