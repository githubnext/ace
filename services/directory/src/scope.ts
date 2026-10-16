import { credential } from "./credential";

export type Scope = { ACE_SECRET?: string; TAILNET?: string };

/** A deployment without `ACE_SECRET` or `TAILNET` refuses everything. */
export async function authorized(request: Request, env: Scope): Promise<boolean> {
	if (!env.ACE_SECRET || !env.TAILNET) return false;
	const encoder = new TextEncoder();
	const given = encoder.encode(request.headers.get("authorization") || "");
	const expected = encoder.encode(`Bearer ${await credential(env.ACE_SECRET, env.TAILNET)}`);
	return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}

/** Names the deployment's tailnet, which is public anyway, so a host on another one can say so. */
export function refused(env: Scope): Response {
	return new Response("Unauthorized", {
		status: 401,
		headers: { "ace-tailnet": env.TAILNET || "" },
	});
}
