import { log } from "./log";
import * as tailnet from "./tailnet";

/** Longer bodies are pages, not messages a service wrote for people. */
const SHORT = 200;

/**
 * One line for a service's failed answer: the status, plus the service's own message when it wrote
 * a short plain-text or JSON one. Error pages from whatever fronts the service (a Cloudflare
 * exception page, a proxy) go to the host log instead, so the app never shows raw HTML. Every
 * caller is a team service, so a 401 says why the team's credential was refused.
 */
export async function refusal(response: Response, service: string): Promise<string> {
	if (response.status === 401) return rejection(response, service);
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

/** Why a team service refused this host, naming both tailnets when they differ. */
export async function rejection(response: Response, service: string): Promise<string> {
	await response.body?.cancel();
	const served = response.headers.get("ace-tailnet");
	const domain = await tailnet.domain();
	if (!served) {
		return `${service} names no tailnet: it predates tailnet-scoped services or lacks its TAILNET setting. Check its URL against your team's current services.`;
	}
	if (domain && served !== domain) {
		return `${service} serves the ${served} tailnet, but this Mac is on ${domain}. Switch tailnets, or use services deployed for this one.`;
	}
	return `${service} rejected this host's ACE_SECRET. Ask whoever set it up for the team's secret.`;
}
