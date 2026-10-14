import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { root } from "./build";
import { archiveName, type Release } from "./release";

const workflow = "desktop-release.yml";
const help = `Signed desktop builds from an Ace channel or terminal. Requires gh auth login.

  bun desktop ci canary|stable [--publish]  build the current, clean, pushed lane
  bun desktop ci status <run-id>           show progress and failed steps
  bun desktop ci download <run-id>         download and verify a successful build

Signing credentials stay in GitHub. Publishing is off unless --publish is supplied.`;

function output(command: string[]): string {
	const result = Bun.spawnSync(command, {
		cwd: root,
		env: { ...process.env, GH_PROMPT_DISABLED: "1" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (!result.success) {
		throw new Error(result.stderr.toString().trim() || `${command[0]} failed`);
	}
	return result.stdout.toString().trim();
}

function api(path: string, ...args: string[]): string {
	return output(["gh", "api", "-H", "X-GitHub-Api-Version: 2026-03-10", path, ...args]);
}

function start(repo: string, channel: string, publish: boolean): void {
	if (output(["git", "status", "--porcelain"])) {
		throw new Error("Commit the lane's changes before starting a release build");
	}
	const branch = output(["git", "symbolic-ref", "--short", "HEAD"]);
	const revision = output(["git", "rev-parse", "HEAD"]);
	const remote = JSON.parse(api(`repos/${repo}/branches/${encodeURIComponent(branch)}`)) as {
		commit: { sha: string };
	};
	if (remote.commit.sha !== revision) {
		throw new Error(`Push this lane so ${repo}'s ${branch} matches ${revision}`);
	}
	const run = JSON.parse(api(
		`repos/${repo}/actions/workflows/${workflow}/dispatches`,
		"--method",
		"POST",
		"-f",
		`ref=${branch}`,
		"-f",
		`inputs[channel]=${channel}`,
		"-F",
		`inputs[publish]=${publish}`,
		"-f",
		`inputs[revision]=${revision}`,
	)) as { workflow_run_id: number; html_url: string };
	console.log(`Queued ${channel} at ${revision}${publish ? " with publishing enabled" : ""}.`);
	console.log(run.html_url);
	console.log(`bun desktop ci status ${run.workflow_run_id}`);
	console.log(`bun desktop ci download ${run.workflow_run_id}`);
}

type Run = {
	html_url: string;
	path: string;
	display_title: string;
	status: string;
	conclusion: string | null;
};

function download(repo: string, id: string, run: Run): void {
	if (run.status !== "completed" || run.conclusion !== "success") {
		throw new Error(`The release is ${run.conclusion || run.status}. Check ${run.html_url}`);
	}
	const { artifacts } = JSON.parse(api(`repos/${repo}/actions/runs/${id}/artifacts`)) as {
		artifacts: { name: string; expired: boolean }[];
	};
	const artifact = artifacts.find(({ name }) => /^ace-(canary|stable)-macos-arm64$/.test(name));
	if (!artifact || artifact.expired) throw new Error("The release artifact is missing or expired");
	const path = join(root, "artifacts", "ci", id);
	mkdirSync(path, { recursive: true });
	output(["gh", "run", "download", id, "--repo", repo, "--name", artifact.name, "--dir", path]);
	const release = JSON.parse(readFileSync(join(path, "release.json"), "utf8")) as Release;
	if (
		!/^\d+\.\d+\.\d+$/.test(release.version)
		|| artifact.name !== `ace-${release.channel}-macos-arm64`
		|| release.archive !== archiveName(release.channel, release.version)
		|| !/^[a-f0-9]{40}$/.test(release.revision)
	) throw new Error("The downloaded release manifest does not match this build");
	const title = `Ace ${release.channel} at ${release.revision}`;
	if (run.display_title !== title && run.display_title !== `${title} (publish)`) {
		throw new Error("The downloaded source revision does not match the requested release");
	}
	const dmg = join(path, release.archive);
	const sha256 = createHash("sha256").update(readFileSync(dmg)).digest("hex");
	if (sha256 !== release.sha256) throw new Error("The downloaded DMG checksum does not match");
	console.log(`Verified Ace ${release.channel} ${release.version} from ${release.revision}.`);
	console.log(dmg);
}

function main(): void {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: true,
		options: {
			publish: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	const [command, id] = positionals;
	if (values.help || !command) return console.log(help);
	const build = command === "canary" || command === "stable";
	if (build && positionals.length !== 1) throw new Error(help);
	if (!build) {
		if (command !== "status" && command !== "download") throw new Error(help);
		if (positionals.length !== 2 || !/^\d+$/.test(id!) || values.publish) throw new Error(help);
	}
	const repo = output(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
	if (build) return start(repo, command, !!values.publish);
	const run = JSON.parse(api(`repos/${repo}/actions/runs/${id}`)) as Run;
	if (run.path.split("@")[0] !== `.github/workflows/${workflow}`) {
		throw new Error("This is not a Desktop release run");
	}
	if (command === "download") return download(repo, id!, run);
	console.log(output(["gh", "run", "view", id!, "--repo", repo, "--verbose"]));
	if (run.status === "completed" && run.conclusion !== "success") process.exitCode = 1;
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
