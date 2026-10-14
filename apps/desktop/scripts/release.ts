import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { version } from "../package.json";
import { build, root } from "./build";
import { sign } from "./sign";
import { run, sparkle } from "./downloads";

export function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Set ${name} before making a release`);
	return value;
}

export function signedTool(command: string[]): void {
	const result = Bun.spawnSync(command, {
		stdin: Buffer.from(required("ACE_SPARKLE_PRIVATE_KEY").trim()),
		stdout: "inherit",
		stderr: "inherit",
	});
	if (!result.success) throw new Error(`${command[0]} failed with exit code ${result.exitCode}`);
}

function log(message: string): void {
	console.log(`${new Date().toISOString()} ${message}`);
}

function phase(name: string): void {
	log(`==> ${name}`);
}

// Apple's ticket lookup intermittently drops connections (stapler exit 68) after notarization succeeds.
async function staple(path: string): Promise<void> {
	for (let attempt = 1;; attempt++) {
		try {
			return run(["xcrun", "stapler", "staple", path]);
		} catch (error) {
			if (attempt === 5) throw error;
			const seconds = 20 * 2 ** (attempt - 1);
			console.log(`Stapling attempt ${attempt} failed; retrying in ${seconds}s`);
			await Bun.sleep(seconds * 1000);
		}
	}
}

export type Release = {
	version: string;
	revision: string;
	channel: string;
	archive: string;
	url: string;
	sha256: string;
};

// The main channel's public names omit the channel; only canary is labeled.
export const prefix = (channel: string) => channel === "stable" ? "" : `${channel}-`;

export const archiveName = (channel: string, version: string) =>
	`ace-${prefix(channel)}${version}-macos-arm64.dmg`;

async function release(): Promise<void> {
	const channel = process.argv[2] || "canary";
	if (channel !== "canary" && channel !== "stable") throw new Error("Choose canary or stable");
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error("Use an incrementing x.y.z desktop version");
	}
	const changes = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root });
	if (!changes.success || changes.stdout.length) {
		throw new Error("Commit the lane's changes before making a release");
	}
	const source = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
	if (!source.success) throw new Error("Cannot determine the release's source revision");
	const revision = source.stdout.toString().trim();
	const identity = required("ACE_CODESIGN_IDENTITY");
	const origin = new URL(required("ACE_UPDATE_URL"));
	if (
		origin.protocol !== "https:" || origin.username || origin.password || origin.search
		|| origin.hash
	) {
		throw new Error(
			"ACE_UPDATE_URL must be a public HTTPS base URL without credentials or a query",
		);
	}
	const seed = Buffer.from(required("ACE_SPARKLE_PRIVATE_KEY").trim(), "base64");
	if (seed.length !== 32) {
		throw new Error("Use a current Sparkle private key exported by generate_keys -x");
	}
	const privateKey = createPrivateKey({
		key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
		format: "der",
		type: "pkcs8",
	});
	const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(
		-32,
	).toString("base64");
	if (publicKey !== required("ACE_UPDATE_PUBLIC_KEY")) {
		throw new Error("The Sparkle private key does not match ACE_UPDATE_PUBLIC_KEY");
	}
	const key = required("ACE_NOTARY_KEY");
	const keyId = required("ACE_NOTARY_KEY_ID");
	const issuer = required("ACE_NOTARY_ISSUER");
	const auth = ["--key", key, "--key-id", keyId, "--issuer", issuer];
	function notary(args: string[]) {
		return Bun.spawnSync(["xcrun", "notarytool", ...args, ...auth, "--output-format", "json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
	}
	function notarize(path: string) {
		const submitted = notary(["submit", path]);
		if (!submitted.success) {
			throw new Error(`Notarization upload failed: ${submitted.stderr.toString()}`);
		}
		const { id } = JSON.parse(submitted.stdout.toString()) as { id: string };
		log(`Notarization submitted: ${id}`);
		// Credentials are named by environment variable so the printed commands are safe to share.
		const check = [
			`xcrun notarytool info ${id} --key "$ACE_NOTARY_KEY" --key-id "$ACE_NOTARY_KEY_ID" --issuer "$ACE_NOTARY_ISSUER"`,
			`xcrun notarytool log ${id} --key "$ACE_NOTARY_KEY" --key-id "$ACE_NOTARY_KEY_ID" --issuer "$ACE_NOTARY_ISSUER"`,
		].join("\n");
		// The service keeps processing past the wait's timeout, so info decides the outcome.
		notary(["wait", id, "--timeout", "20m"]);
		const info = notary(["info", id]);
		if (!info.success) {
			throw new Error(
				`Notarization ${id} status is unavailable: ${info.stderr.toString()}\nCheck it later with:\n${check}`,
			);
		}
		const { status } = JSON.parse(info.stdout.toString()) as { status: string };
		if (status === "In Progress") {
			throw new Error(
				`Notarization ${id} is still in progress after 20 minutes. Check it later with:\n${check}`,
			);
		}
		if (status !== "Accepted") {
			throw new Error(
				`Notarization ${id} finished with status ${status}. Retrieve its log before releasing:\n${check}`,
			);
		}
		log(`Notarization accepted: ${id}`);
	}

	phase("Build");
	await build(channel);
	const sdk = await sparkle();
	const staging = join(root, ".tmp", `release-${crypto.randomUUID()}`);
	const output = join(root, "artifacts", "sparkle");
	mkdirSync(staging, { recursive: true });
	mkdirSync(output, { recursive: true });
	try {
		// Electrobun's archive contains the actual app; its outer launcher is not an update.
		const archive = readdirSync(join(root, "artifacts")).find((file) =>
			file.endsWith(".app.tar.zst")
		);
		if (!archive) throw new Error("Electrobun did not produce an application archive");
		const tar = join(staging, "app.tar");
		run([
			join(root, "node_modules", "electrobun", "dist-macos-arm64", "zig-zstd"),
			"decompress",
			"-i",
			join(root, "artifacts", archive),
			"-o",
			tar,
		]);
		run(["/usr/bin/tar", "-xf", tar, "-C", staging]);
		const built = readdirSync(staging).find((file) => file.endsWith(".app"));
		if (!built) throw new Error("The application archive is empty");
		const name = channel === "stable" ? "Ace" : "Ace Canary";
		const app = join(staging, `${name}.app`);
		if (built !== `${name}.app`) renameSync(join(staging, built), app);
		phase("App signing");
		sign(app, identity, true);
		const zip = join(staging, "notarize.zip");
		run(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
		phase("App notarization");
		notarize(zip);
		phase("App stapling and verification");
		await staple(app);
		run(["/usr/sbin/spctl", "--assess", "--type", "execute", app]);
		phase("DMG");
		const volume = join(staging, "volume");
		mkdirSync(volume);
		run(["/usr/bin/ditto", app, join(volume, `${name}.app`)]);
		symlinkSync("/Applications", join(volume, "Applications"));
		const filename = archiveName(channel, version);
		const dmg = join(output, filename);
		run([
			"/usr/bin/hdiutil",
			"create",
			"-volname",
			name,
			"-srcfolder",
			volume,
			"-format",
			"UDZO",
			dmg,
		]);
		run(["/usr/bin/codesign", "--force", "--sign", identity, "--timestamp", dmg]);
		phase("DMG notarization");
		notarize(dmg);
		phase("DMG stapling and verification");
		await staple(dmg);
		run(["xcrun", "stapler", "validate", dmg]);
		phase("Appcast");
		const url = `${origin.href.replace(/\/$/, "")}/${channel}/macos-arm64/`;
		signedTool([
			join(sdk, "bin", "generate_appcast"),
			"--ed-key-file",
			"-",
			"--download-url-prefix",
			url,
			"--maximum-deltas",
			"0",
			output,
		]);
		signedTool([
			join(sdk, "bin", "sign_update"),
			"--verify",
			"--ed-key-file",
			"-",
			join(output, "appcast.xml"),
		]);
		const sha256 = createHash("sha256").update(await Bun.file(dmg).bytes()).digest("hex");
		writeFileSync(
			join(output, "release.json"),
			JSON.stringify(
				{ version, revision, channel, archive: filename, url, sha256 } satisfies Release,
				null,
				"\t",
			),
		);
		console.log(`Release ready in ${output}. Nothing has been published.`);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

if (import.meta.main) await release();
