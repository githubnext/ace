import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const USAGE = `bun services/celld.ts <channel|directory> dev [celld dev options]
bun services/celld.ts <channel|directory> deploy <vars-file> --bucket <bucket> [celld deploy options]`;

const [service, command, ...rest] = process.argv.slice(2);
if (!service || !["channel", "directory"].includes(service)) throw new Error(USAGE);
if (command !== "dev" && command !== "deploy") throw new Error(USAGE);

const root = join(import.meta.dir, service);
const config: Record<string, unknown> = (await import(join(root, "wrangler.jsonc"))).default;
// celld refuses keys it doesn't implement, and Workers Logs is Cloudflare's.
delete config.observability;

let args = rest;
if (command === "deploy") {
	const [file, ...options] = rest;
	if (!file) throw new Error(USAGE);
	// celld has no secret store: these become plain vars in the fleet bucket's deployment.
	config.vars = parse(await Bun.file(file).text());
	args = options;
}

// Wrangler's own esbuild keeps the celld and Cloudflare bundles alike.
const wrangler = dirname(Bun.resolveSync("wrangler/package.json", root));
const generated = join(root, "celld.json");
await Bun.write(generated, JSON.stringify(config, null, "\t"));
try {
	const child = Bun.spawn(["celld", command, generated, ...args], {
		cwd: root,
		env: { ...process.env, CELLD_ESBUILD: Bun.resolveSync("esbuild/bin/esbuild", wrangler) },
		stdio: ["inherit", "inherit", "inherit"],
	});
	process.exitCode = await child.exited;
} finally {
	await rm(generated, { force: true });
}

function parse(text: string): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (match) vars[match[1]!] = match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
	}
	return vars;
}
