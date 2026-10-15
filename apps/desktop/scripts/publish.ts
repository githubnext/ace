import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { S3Client } from "bun";

import { root } from "./build";
import { publishGithub } from "./github-release";
import { type Release, required, signedTool } from "./release";
import { sparkle } from "./downloads";
import { bundlePattern, order } from "./version";

const output = join(root, "artifacts", "sparkle");
const release = await Bun.file(join(output, "release.json")).json() as Release;
if (!bundlePattern.test(release.version)) {
	throw new Error("The release manifest's version is not orderable");
}
const bucket = required("ACE_UPDATE_BUCKET");
const account = required("CLOUDFLARE_ACCOUNT_ID");
const storage = new S3Client({
	bucket,
	endpoint: `https://${account}.r2.cloudflarestorage.com`,
	region: "auto",
	accessKeyId: required("R2_ACCESS_KEY_ID"),
	secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
});
const sdk = await sparkle();
const feed = join(output, "appcast.xml");
const verify = (path: string) =>
	signedTool([join(sdk, "bin", "sign_update"), "--verify", "--ed-key-file", "-", path]);
verify(feed);

const remote = await fetch(`${release.url}appcast.xml?check=${crypto.randomUUID()}`, {
	signal: AbortSignal.timeout(30_000),
});
if (remote.ok) {
	const text = await remote.text();
	const cache = join(root, ".tmp", "published-appcast.xml");
	mkdirSync(join(root, ".tmp"), { recursive: true });
	writeFileSync(cache, text);
	verify(cache);
	const versions = [...text.matchAll(/<sparkle:version>([^<]+)<\/sparkle:version>/g)].map((match) =>
		match[1]
	);
	if (
		!versions.length
		|| versions.some((version) =>
			!bundlePattern.test(version) || order(version, release.version) > 0
		)
	) {
		throw new Error("Refusing to replace a newer or unrecognized release feed");
	}
} else if (remote.status !== 404) {
	throw new Error(`Could not read the existing feed: ${remote.status}`);
}

const archive = join(output, release.archive);
const digest = (buffer: ArrayBuffer) =>
	createHash("sha256").update(new Uint8Array(buffer)).digest("hex");
if (digest(await Bun.file(archive).arrayBuffer()) !== release.sha256) {
	throw new Error("The release archive changed after signing");
}
const target = decodeURIComponent(new URL(release.url).pathname).replace(/^\/|\/$/g, "");

async function upload(file: string, type: string, cache: string) {
	const url = storage.presign(`${target}/${file}`, { method: "PUT", expiresIn: 900 });
	const response = await fetch(url, {
		method: "PUT",
		body: Bun.file(join(output, file)),
		headers: { "content-type": type, "cache-control": cache },
		signal: AbortSignal.timeout(300_000),
	}).catch(() => {
		// A fetch error can contain the signed URL, which grants temporary write access.
		throw new Error(`Could not upload ${file} to R2`);
	});
	if (!response.ok) throw new Error(`R2 refused ${file}: ${response.status}`);
}

const current = await fetch(`${release.url}${release.archive}?check=${crypto.randomUUID()}`, {
	signal: AbortSignal.timeout(120_000),
});
if (current.ok) {
	if (digest(await current.arrayBuffer()) !== release.sha256) {
		throw new Error(
			"That release version already exists with different bytes. Release a new build.",
		);
	}
} else if (current.status === 404) {
	await upload(
		release.archive,
		"application/x-apple-diskimage",
		"public, max-age=31536000, immutable",
	);
} else throw new Error(`Could not check the existing archive: ${current.status}`);

const downloaded = await fetch(`${release.url}${release.archive}`, {
	signal: AbortSignal.timeout(120_000),
});
if (!downloaded.ok || digest(await downloaded.arrayBuffer()) !== release.sha256) {
	throw new Error(
		"The public download does not match the signed archive. The feed has not been published.",
	);
}
// A shipped feed must already have its versioned GitHub release and DMG.
await publishGithub(output);
// The feed is the commit point: all downloads must already exist and remain immutable.
await upload("appcast.xml", "application/rss+xml", "no-store");
const published = await fetch(`${release.url}appcast.xml?check=${crypto.randomUUID()}`, {
	signal: AbortSignal.timeout(30_000),
});
if (!published.ok || await published.text() !== await Bun.file(feed).text()) {
	throw new Error("The published feed could not be verified. Check the bucket's cache rules.");
}
console.log(
	`Published Ace ${release.display} (${release.version}) to ${release.channel}: ${release.url}${release.archive}`,
);
