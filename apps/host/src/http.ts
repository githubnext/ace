import { log } from "./log";

/** Longer bodies are pages, not messages a service wrote for people. */
const SHORT = 200;

/**
 * One line for a service's failed answer: the status, plus the service's own message when it wrote
 * a short plain-text or JSON one. Error pages from whatever fronts the service (a Cloudflare
 * exception page, a proxy) go to the host log instead, so the app never shows raw HTML.
 */
export async function refusal(response: Response, service: string): Promise<string> {
	const body = await response.text().catch(() => "");
	log("warn", "http.refused", { url: response.url, status: response.status, body });
	const text = said(response.headers.get("content-type") || "", body);
	const verb = response.status >= 500 ? "failed" : "refused";
	return `${service} ${verb} (HTTP ${response.status})${text ? `: ${text}` : ""}`.replace(
		/[.\s]*$/,
		".",
	);
}

function said(type: string, body: string): string {
	let text = "";
	if (type.startsWith("text/plain")) text = body.trim();
	if (type.startsWith("application/json")) {
		try {
			const value = JSON.parse(body);
			text = [value?.error, value?.message].find((field) => typeof field === "string") || "";
		} catch {}
	}
	return text.length <= SHORT && !/[\r\n]/.test(text) ? text : "";
}
