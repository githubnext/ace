/**
 * An invite link carries the team's directory URL and secret in one string a teammate can click or
 * paste. Opening one only fills in the join form; the person still checks and joins.
 */
export type Invite = { url: string; secret: string };

/** Stable's scheme: teammates run the stable app. Canary and dev builds register their own. */
export function link({ url, secret }: Invite): string {
	return `ace://join?${new URLSearchParams({ directory: url, secret })}`;
}

/** Reads a link from any build's scheme (ace, ace-canary, ace-dev). */
export function parse(text: string): Invite | undefined {
	let value: URL;
	try {
		value = new URL(text.trim());
	} catch {
		return;
	}
	if (!/^ace(-[a-z]+)?:$/.test(value.protocol) || value.host !== "join") return;
	const url = value.searchParams.get("directory");
	const secret = value.searchParams.get("secret");
	if (url && secret) return { url, secret };
}
