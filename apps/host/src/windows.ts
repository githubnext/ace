import type { HostFrame, HostRequest, TabResult, WindowInfo, WindowState } from "./protocol";

type Socket = { send(data: string): unknown };
type Window = { id: string; socket: Socket; value: WindowState };
type Pending = {
	window: Window;
	channel: string;
	tab: string;
	resolve(value: WindowInfo): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
};

const windows = new Map<string, Window>();
const sockets = new Map<Socket, Window>();
const pending = new Map<string, Pending>();
const TIMEOUT = 5000;

/** A disconnected client has no layout the host can inspect or change. */
export function drop(socket: Socket): void {
	const window = sockets.get(socket);
	if (!window) return;
	sockets.delete(socket);
	windows.delete(window.id);
	for (const [call, request] of pending) {
		if (request.window !== window) continue;
		pending.delete(call);
		clearTimeout(request.timer);
		request.reject(new Error("The Ace window disconnected or closed its channel"));
	}
}

export function publish(socket: Socket, value: WindowState | null): { id: string } | null {
	if (!value) {
		drop(socket);
		return null;
	}
	let window = sockets.get(socket);
	if (window) window.value = value;
	else {
		window = { id: crypto.randomUUID(), socket, value };
		windows.set(window.id, window);
		sockets.set(socket, window);
	}
	return { id: window.id };
}

export function list(): WindowInfo[] {
	return [...windows.values()].map(({ id, value }) => ({
		id,
		channel: value.channel,
		tabs: value.tabs,
		focused: value.focused,
	}));
}

export function rename(request: Extract<HostRequest, { op: "tab-rename" }>): Promise<WindowInfo> {
	const window = windows.get(request.window);
	if (!window) throw new Error("No connected Ace window with that ID; list tabs again");
	if (window.value.channel.id !== request.channel) {
		throw new Error("That Ace window is showing a different channel; list tabs again");
	}
	const tab = window.value.tabs.find((tab) => tab.id === request.tab);
	if (!tab) throw new Error("That tab is closed or unknown; list tabs again");
	if (tab.type === "chat") {
		throw new Error("The Chat tab follows the channel name and cannot be renamed");
	}
	return send(window, request.channel, request.tab, request.name);
}

export function live(request: Extract<HostRequest, { op: "tab-live" }>): Promise<WindowInfo> {
	const window = windows.get(request.window);
	if (!window) throw new Error("No connected Ace window with that ID; list tabs again");
	if (window.value.channel.id !== request.channel) {
		throw new Error("That Ace window is showing a different channel; list tabs again");
	}
	return send(window, request.channel, "", request.name, request.target);
}

function send(
	window: Window,
	channel: string,
	tab: string,
	text: string,
	target?: number,
): Promise<WindowInfo> {
	const name = text.trim();
	if (name.length > 80) throw new Error("A tab name must be at most 80 characters");
	const call = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(call);
			reject(new Error("The Ace window did not respond; list tabs to check its current state"));
		}, TIMEOUT);
		pending.set(call, {
			window,
			channel,
			tab,
			resolve,
			reject,
			timer,
		});
		try {
			window.socket.send(JSON.stringify(
				{
					rename: {
						call,
						channel,
						tab,
						name,
						expires: Date.now() + TIMEOUT,
						...(target === undefined ? {} : { live: target }),
					},
				} satisfies HostFrame,
			));
		} catch (error) {
			pending.delete(call);
			clearTimeout(timer);
			reject(error);
		}
	});
}

export function result(socket: Socket, call: string, result: TabResult): void {
	const request = pending.get(call);
	// A late response is harmless; another window must never complete someone else's call.
	if (!request) return;
	if (request.window.socket !== socket) {
		throw new Error("This rename belongs to another Ace window");
	}
	pending.delete(call);
	clearTimeout(request.timer);
	if (!result.ok) return request.reject(new Error(result.error));
	if (
		result.value.channel.id !== request.channel
		|| (request.tab && !result.value.tabs.some((tab) => tab.id === request.tab))
	) {
		return request.reject(
			new Error("The Ace window changed channels or closed the tab during rename"),
		);
	}
	request.window.value = result.value;
	request.resolve({ ...result.value, id: request.window.id });
}
