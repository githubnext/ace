/**
 * An invite link carries the team's directory URL and secret in one string a teammate can click or
 * paste. Opening one only fills in the join form; the person still checks and joins.
 */
export type Invite = { url: string; secret: string };

/**
 * An https page, because chat apps linkify it and not `ace://`; it offers the download, then hands
 * off to stable's `ace://join`. The invite rides in the fragment, which browsers never send.
 */
export const page = "https://ace.githubnext.com/join";

export function link({ url, secret }: Invite): string {
	return `${page}#${new URLSearchParams({ directory: url, secret })}`;
}

/** Reads the page's link, or a handoff in any build's scheme (ace, ace-canary, ace-dev). */
export function parse(text: string): Invite | undefined {
	let value: URL;
	try {
		value = new URL(text.trim());
	} catch {
		return;
	}
	const params = `${value.origin}${value.pathname}`.replace(/\/$/, "") === page
		? new URLSearchParams(value.hash.slice(1))
		: /^ace(-[a-z]+)?:$/.test(value.protocol) && value.host === "join"
		? value.searchParams
		: undefined;
	const url = params?.get("directory");
	const secret = params?.get("secret");
	if (url && secret) return { url, secret };
}
