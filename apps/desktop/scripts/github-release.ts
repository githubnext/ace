import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { root } from "./build";
import { archiveName, prefix, type Release } from "./release";

type GithubRelease = {
	id: number;
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	target_commitish: string;
	html_url: string;
	assets: { name: string; digest: string | null; state: string }[];
};

function gh(args: string[], missing = false): string | undefined {
	const result = Bun.spawnSync(["gh", ...args], {
		cwd: root,
		env: { ...process.env, GH_PROMPT_DISABLED: "1" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.success) return result.stdout.toString().trim();
	const error = result.stderr.toString().trim();
	if (missing && error.includes("(HTTP 404)")) return undefined;
	throw new Error(error || "GitHub release command failed");
}

const version = (tag: string) => tag.slice(tag.lastIndexOf("-v") + 2);

function compare(a: string, b: string): number {
	const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
	return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
}

export async function publishGithub(directory: string): Promise<void> {
	const release = await Bun.file(join(directory, "release.json")).json() as Release;
	if (
		!/^(canary|stable)$/.test(release.channel)
		|| !/^\d+\.\d+\.\d+$/.test(release.version)
		|| !/^[a-f0-9]{40}$/.test(release.revision)
		|| release.archive !== archiveName(release.channel, release.version)
	) throw new Error("Invalid desktop release manifest");
	const archive = join(directory, release.archive);
	const digest = createHash("sha256").update(await Bun.file(archive).bytes()).digest("hex");
	if (digest !== release.sha256) throw new Error("The DMG does not match its release manifest");

	const repo = process.env.GITHUB_REPOSITORY
		|| gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])!;
	const tags = `desktop-${prefix(release.channel)}v`;
	const tag = `${tags}${release.version}`;
	const title = release.channel === "stable"
		? `Ace ${release.version}`
		: `Ace canary ${release.version}`;
	const endpoint = `repos/${repo}`;
	const prerelease = release.channel === "canary";
	const ref = gh(["api", `${endpoint}/git/ref/tags/${tag}`], true);
	const commit = ref ? gh(["api", `${endpoint}/commits/${tag}`]) : undefined;
	if (commit && (JSON.parse(commit) as { sha: string }).sha !== release.revision) {
		throw new Error(`${tag} already points to another source revision`);
	}
	// Listing includes unfinished drafts, so retries can resume after an upload failure.
	const releases = gh([
		"api",
		`${endpoint}/releases`,
		"--paginate",
		"--jq",
		`.[] | select(.tag_name | startswith("${tags}"))`,
	])!.split("\n").filter(Boolean).map((line) => JSON.parse(line) as GithubRelease);
	const existing = releases.find((item) => item.tag_name === tag);
	let published: GithubRelease;
	if (existing) {
		published = existing;
		if (
			published.prerelease !== prerelease
			|| (published.draft && published.target_commitish !== release.revision)
			|| (!published.draft && !commit)
		) throw new Error(`${tag} does not match the requested release`);
	} else {
		const previous = releases
			.filter((item) => !item.draft && compare(version(item.tag_name), release.version) < 0)
			.sort((a, b) => compare(version(b.tag_name), version(a.tag_name)))[0];
		const changes = JSON.parse(
			gh([
				"api",
				`${endpoint}/releases/generate-notes`,
				"--method",
				"POST",
				"-f",
				`tag_name=${tag}`,
				"-f",
				`target_commitish=${release.revision}`,
				...(previous ? ["-f", `previous_tag_name=${previous.tag_name}`] : []),
			])!,
		) as { body: string };
		const notes = `${title} for Apple silicon (macOS 15+).\n\n`
			+ `Source: ${release.revision}\n\nSHA-256 (${release.archive}): ${digest}\n\n`
			+ changes.body;
		published = JSON.parse(
			gh([
				"api",
				`${endpoint}/releases`,
				"--method",
				"POST",
				"-f",
				`tag_name=${tag}`,
				"-f",
				`target_commitish=${release.revision}`,
				"-f",
				`name=${title}`,
				"-f",
				`body=${notes}`,
				"-F",
				"draft=true",
				"-F",
				`prerelease=${prerelease}`,
				"-f",
				"make_latest=false",
			])!,
		) as GithubRelease;
	}

	const asset = published.assets.find(({ name }) => name === release.archive);
	if (asset && (asset.state !== "uploaded" || asset.digest !== `sha256:${digest}`)) {
		throw new Error(`${tag} already has a different or incomplete DMG; refusing to overwrite it`);
	}
	if (!asset) {
		gh(["release", "upload", tag, archive, "--repo", repo]);
		published = JSON.parse(gh(["api", `${endpoint}/releases/${published.id}`])!) as GithubRelease;
		const uploaded = published.assets.find(({ name }) => name === release.archive);
		if (uploaded?.state !== "uploaded" || uploaded.digest !== `sha256:${digest}`) {
			throw new Error("GitHub did not confirm the uploaded DMG checksum");
		}
	}
	if (published.draft) {
		published = JSON.parse(
			gh([
				"api",
				`${endpoint}/releases/${published.id}`,
				"--method",
				"PATCH",
				"-F",
				"draft=false",
				"-f",
				`make_latest=${prerelease ? "false" : "true"}`,
			])!,
		) as GithubRelease;
	}
	const source = JSON.parse(gh(["api", `${endpoint}/commits/${tag}`])!) as { sha: string };
	if (published.draft || source.sha !== release.revision) {
		throw new Error("The published GitHub release does not match the source revision");
	}
	console.log(`Published GitHub release: ${published.html_url}`);
}

if (import.meta.main) {
	const directory = process.argv[2];
	if (!directory) {
		throw new Error("Usage: bun apps/desktop/scripts/github-release.ts <artifact-directory>");
	}
	await publishGithub(resolve(directory));
}
