import { GatewayClient } from "@ace/host/gateway-client";

import { gateway } from "./address";

declare global {
	interface Window {
		__ACE_TOKEN__?: string;
		__ACE_DESKTOP__?: boolean;
	}
}

const fragment = new URLSearchParams(location.hash.slice(1));
export const nativeToken = window.__ACE_DESKTOP__ ? window.__ACE_TOKEN__ : undefined;
const token = window.__ACE_TOKEN__ || fragment.get("token") || undefined;
delete window.__ACE_TOKEN__;
delete window.__ACE_DESKTOP__;
if (fragment.has("token")) {
	fragment.delete("token");
	history.replaceState(
		null,
		"",
		`${location.pathname}${location.search}${fragment.size ? `#${fragment}` : ""}`,
	);
}

// main.tsx loads the app only once there is a gateway to reach.
export const host = new GatewayClient(gateway!, token);

// A sign-in link opened in a tab already on this origin changes only the hash, so nothing reads it.
window.addEventListener("hashchange", () => {
	if (new URLSearchParams(location.hash.slice(1)).has("token")) location.reload();
});

/**
 * Why the host refuses this page's socket: its credentials (401), as after Ace Helper restarts
 * with a new token, or because it is a teammate's host (403, whose text names its owner). A
 * browser hides a WebSocket's status, so this asks over HTTP with what the socket sends.
 */
export async function refused(): Promise<"signed-out" | { other: string } | undefined> {
	const response = await fetch(gateway!.replace(/^ws/, "http"), {
		cache: "no-store",
		...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
	}).catch(() => undefined);
	if (response?.status === 401) return "signed-out";
	if (response?.status === 403) return { other: await response.text() };
}

// Phones suspend backgrounded pages; reconnect as soon as the person comes back.
for (const event of ["visibilitychange", "online", "pageshow"]) {
	window.addEventListener(event, () => {
		if (document.visibilityState === "visible") host.wake();
	});
}

const opens = new Set<() => void>();
host.onOpen = () => {
	for (const open of opens) open();
};

/** Runs after every host connect, so each view can re-establish its own watches. */
export function onOpen(listener: () => void) {
	opens.add(listener);
	return () => void opens.delete(listener);
}
