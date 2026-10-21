import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const USAGE = "bun services/deploy.ts <cloudflare|fly> <team>";
const MODEL_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

const [provider, team] = process.argv.slice(2);
if (provider !== "cloudflare" && provider !== "fly") throw new Error(USAGE);
// App and Worker names: ace-directory-<team> and ace-channel-<team>.
if (!team || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(team)) {
	throw new Error(`${USAGE}\n<team> is lowercase letters, digits, and dashes`);
}

const tailnet = await magicDNS();
const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
const models: Record<string, string> = {};
for (const name of MODEL_KEYS) if (process.env[name]) models[name] = process.env[name]!;
if (!Object.keys(models).length) {
	const names = MODEL_KEYS.join(" or ");
	console.warn(`No ${names} in the environment: hosted channels can't run agents without one.`);
}

const shared = { ACE_SECRET: secret, TAILNET: tailnet };
const deploy = provider === "cloudflare" ? cloudflare : fly;
const hosted = await deploy("channel", { ...shared, ...models });
const directory = await deploy("directory", { ...shared, HOSTED: hosted });

console.log(`
Deployed for ${tailnet}.

  Directory    ${directory}
  Team secret  ${secret}

Join in Ace with both, then send them to teammates privately. This is the only time the secret is shown.
The services can take a minute to accept the new secret.`);

async function cloudflare(service: string, vars: Record<string, string>): Promise<string> {
	const name = `ace-${service}-${team}`;
	const output = await run(["bunx", "wrangler", "deploy", "--name", name], { dir: service });
	const url = /https:\/\/\S+\.workers\.dev/.exec(output)?.[0];
	if (!url) throw new Error(`wrangler deploy printed no workers.dev URL for ${name}`);
	await run(["bunx", "wrangler", "secret", "bulk", "--name", name], {
		dir: service,
		input: JSON.stringify(vars),
	});
	return url;
}

async function fly(service: string, vars: Record<string, string>): Promise<string> {
	const app = `ace-${service}-${team}`;
	await run(["fly", "apps", "create", app]);
	// Tigris prints the bucket's keys once, and deploying the service's code to the bucket needs them.
	const storage = await run(["fly", "storage", "create", "-a", app, "-n", app, "--yes"], {
		quiet: true,
	});
	const key = (name: string) => {
		const value = new RegExp(`${name}:\\s*(\\S+)`).exec(storage)?.[1];
		if (!value) throw new Error(`fly storage create printed no ${name} for ${app}`);
		return value;
	};
	const bucket = `s3://${app}`;
	await run(["fly", "secrets", "set", "-a", app, "--stage", `CELLD_BUCKET=${bucket}`]);
	// celld has no secret store, so these vars sit in the bucket as plain text either way.
	const dir = await mkdtemp(join(tmpdir(), "ace-deploy-"));
	const file = join(dir, `${service}.env`);
	try {
		await Bun.write(file, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n"));
		await run(["bun", "celld.ts", service, "deploy", file, "--bucket", bucket], {
			env: {
				S3_ENDPOINT: "https://fly.storage.tigris.dev",
				AWS_REGION: "auto",
				AWS_ACCESS_KEY_ID: key("AWS_ACCESS_KEY_ID"),
				AWS_SECRET_ACCESS_KEY: key("AWS_SECRET_ACCESS_KEY"),
			},
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	await run(["fly", "deploy", "-c", "fly.toml", "-a", app, "--ha=false"]);
	return `https://${app}.fly.dev`;
}

async function magicDNS(): Promise<string> {
	const cli = Bun.which("tailscale") ?? "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
	const status = JSON.parse(await run([cli, "status", "--json"], { quiet: true })) as {
		MagicDNSSuffix?: string;
	};
	if (!status.MagicDNSSuffix) throw new Error("Tailscale reports no tailnet. Connect to it first.");
	return status.MagicDNSSuffix;
}

type Options = { dir?: string; input?: string; env?: Record<string, string>; quiet?: boolean };

/** Runs in `services/<dir>`, echoing output unless `quiet` so progress stays visible, and returns it for parsing. */
async function run(cmd: string[], { dir, input, env, quiet }: Options = {}): Promise<string> {
	const child = Bun.spawn(cmd, {
		cwd: join(import.meta.dir, dir || "."),
		env: { ...process.env, ...env },
		stdin: input === undefined ? "inherit" : new TextEncoder().encode(input),
		stdout: "pipe",
		stderr: "inherit",
	});
	let output = "";
	for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
		output += chunk;
		if (!quiet) process.stdout.write(chunk);
	}
	if (await child.exited) throw new Error(`${cmd.slice(0, 3).join(" ")} failed`);
	return output;
}
