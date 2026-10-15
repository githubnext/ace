/**
 * Where the app's host gateway is. A host serves the app itself, so normally that is this page's
 * own origin. The deployed web app (VITE_ACE_WEB) is served elsewhere and remembers the host the
 * person chose; it can only reach one over HTTPS.
 */
export const deployed = import.meta.env.VITE_ACE_WEB === "1";

const KEY = "ace:host";
const fragment = new URLSearchParams(location.hash.slice(1));

function stored(): string | undefined {
	try {
		return localStorage.getItem(KEY) || undefined;
	} catch {
		return undefined;
	}
}

/** Accepts a bare name such as `mac.tailnet.ts.net:5141` or a full URL. */
export function normalize(value: string): string | undefined {
	const text = value.trim();
	if (!text) return;
	try {
		const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
		return url.host || undefined;
	} catch {
		return undefined;
	}
}

export function remember(value: string | undefined) {
	try {
		if (value) localStorage.setItem(KEY, value);
		else localStorage.removeItem(KEY);
	} catch {}
}

const given = fragment.get("host");
if (given) {
	remember(normalize(given));
	fragment.delete("host");
	history.replaceState(
		null,
		"",
		`${location.pathname}${location.search}${fragment.size ? `#${fragment}` : ""}`,
	);
}

/** The deployed app's chosen host, shown when it cannot be reached. */
export const chosen = deployed ? stored() : undefined;

export const gateway: string | undefined = deployed
	? chosen && `wss://${chosen}/ws`
	: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
