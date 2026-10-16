import { authorized, refused } from "@ace/directory/scope";

import type { Env } from "./object";

export { HostedChannel } from "./object";

const ROUTE = /^\/channels\/([a-z0-9-]{1,64})(\/workspace|\/transfer)?$/;

/**
 * Hosts are trusted to state who wrote each message: they verify their own users over the tailnet
 * and hold the team's secret.
 */
export default {
	async fetch(request, env) {
		const match = ROUTE.exec(new URL(request.url).pathname);
		if (!match) return new Response("Not found", { status: 404 });
		if (!(await authorized(request, env))) return refused(env);
		return env.CHANNEL.get(env.CHANNEL.idFromName(match[1])).fetch(request);
	},
} satisfies ExportedHandler<Env>;
