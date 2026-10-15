export type HelperState = {
	service: "unregistered" | "enabled" | "approval";
	running: boolean;
	managed: boolean;
	/** launchd runs Ace Helper but it did not answer, as while it starts or is busy. */
	unresponsive: boolean;
};

export type HelperAction = "status" | "start" | "stop" | "restart" | "settings" | "log";

export type NativeState = {
	state: "stopped" | "starting" | "ready" | "stopping" | "error";
	accessibility: boolean;
	screenRecording: boolean;
	eventSynthesizing: boolean;
	clipboardRead: {
		policy:
			| "default"
			| "ask"
			| "always_allow"
			| "always_deny"
			| "unavailable_on_this_os"
			| "unknown";
		readAdmitted: boolean;
		policyAvailable: boolean;
	};
	error?: string;
};

export type NativeAction =
	| { op: "status" }
	| { op: "permission"; permission: "accessibility" | "screenRecording" | "eventSynthesizing" };

export type UpdateState = {
	phase:
		| "disabled"
		| "idle"
		| "checking"
		| "available"
		| "preparing"
		| "downloading"
		| "installing"
		| "restarting"
		| "recovering"
		| "error";
	version: string;
	channel: string;
	automatic: boolean;
	canCancel: boolean;
	available?: string;
	checked?: number;
	progress?: number;
	error?: string;
	needsRecovery?: boolean;
};

export type UpdateAction =
	| { op: "status" | "check" | "install" | "cancel" | "recover" }
	| { op: "automatic"; value: boolean };

export type CommandState = {
	/** `ace` for stable; other apps add their channel, so each app's command targets its own data. */
	name: string;
	path: string;
	/** `other` is a file Ace didn't link; `stale` links to another or a moved Ace. */
	link: "installed" | "missing" | "other" | "stale";
	/** What the person's interactive login shell runs for `name`. */
	shell?: string;
};

export type CommandAction = "status" | "install" | "remove";

/** Native actions are separate from the host and never available to tailnet peers. */
export type DesktopRPC = {
	bun: {
		requests: {
			project: { params: { token: string }; response: string | null };
			lights: { params: { token: string; expanded: boolean }; response: null };
			zoom: { params: { token: string }; response: null };
			window: { params: { token: string }; response: null };
			helper: { params: { token: string; action: HelperAction }; response: HelperState };
			native: { params: { token: string; action: NativeAction }; response: NativeState };
			updates: { params: { token: string; action: UpdateAction }; response: UpdateState };
			command: { params: { token: string; action: CommandAction }; response: CommandState };
			notify: { params: { token: string; title: string; body: string }; response: null };
		};
		messages: {};
	};
	webview: { requests: {}; messages: {} };
};
