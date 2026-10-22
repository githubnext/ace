/**
 * Deploy the team's services to the person's own Cloudflare account and join the directory, so
 * the first person on a tailnet needs no checkout. services/deploy.ts does the same from a
 * checkout, and also deploys to Fly.io.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config";
import { setDirectory } from "./settings";
import * as tailnet from "./tailnet";

/** Matches the repository's catalog, so a source run and the app deploy with the same wrangler. */
const WRANGLER = "wrangler@4.140.0";

export type Deployed = { url: string; secret: string };

export async function deploy(waiting: (text: string | null) => void): Promise<Deployed> {
	const domain = await tailnet.domain();
	if (!domain) throw new Error("Connect to Tailscale first: the services serve only your tailnet.");
	// The services serve one tailnet, so its name names them, as tail1234 in tail1234.ts.net.
	const team = domain.split(".")[0]!.toLowerCase();

	waiting("Checking your Cloudflare sign-in…");
	if (!/logged in/i.test(await wrangler(["whoami"]))) {
		waiting("Sign in to Cloudflare in your browser…");
		await wrangler(["login"]);
	}

	const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
	waiting("Deploying the directory…");
	const url = await worker("directory", team, { ACE_SECRET: secret, TAILNET: domain });

	waiting("Joining this Mac to the directory…");
	// A Worker serves its new secrets a few seconds after they're set.
	for (let attempt = 1;; attempt++) {
		try {
			await setDirectory(url, secret);
			break;
		} catch (error) {
			if (attempt === 12) throw error;
			await Bun.sleep(5_000);
		}
	}
	waiting(null);
	return { url, secret };
}

async function worker(
	service: string,
	team: string,
	vars: Record<string, string>,
): Promise<string> {
	const name = `ace-${service}-${team}`;
	// The app ships prebuilt bundles with a wrangler.json; a source run builds from the service.
	const dir = join(config.services, service);
	const file = existsSync(join(dir, "wrangler.json")) ? "wrangler.json" : "wrangler.jsonc";
	const output = await wrangler(["deploy", "-c", join(dir, file), "--name", name]);
	const url = /https:\/\/\S+\.workers\.dev/.exec(output)?.[0];
	if (!url) throw new Error(`Cloudflare gave no workers.dev URL for ${name}`);
	await wrangler(["secret", "bulk", "-c", join(dir, file), "--name", name], JSON.stringify(vars));
	return url;
}

/** Ace Helper is a compiled Bun, which runs as plain Bun with BUN_BE_BUN, so wrangler needs no Node. */
async function wrangler(args: string[], input?: string): Promise<string> {
	const child = Bun.spawn([process.execPath, "x", "--bun", WRANGLER, ...args], {
		env: { ...process.env, BUN_BE_BUN: "1", WRANGLER_SEND_METRICS: "false" },
		stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [output, error] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (await child.exited) {
		const reason = (error || output).trim().split("\n").filter(Boolean).at(-1);
		throw new Error(`wrangler ${args[0]} failed: ${reason}`);
	}
	return output;
}
