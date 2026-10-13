import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "./downloads";

/**
 * Development builds sign with ACE_CODESIGN_IDENTITY or this repository's local Git setting
 * `ace.codesignIdentity`, which every worktree shares, so background builds sign alike.
 */
export function devIdentity(): string {
	const configured = Bun.spawnSync(["git", "config", "--get", "ace.codesignIdentity"], {
		cwd: fileURLToPath(new URL(".", import.meta.url)),
	});
	const identity = process.env.ACE_CODESIGN_IDENTITY || configured.stdout.toString().trim();
	if (!identity || identity === "-") {
		throw new Error(
			"Ace-dev requires stable signing so macOS permissions survive rebuilds. Set ace.codesignIdentity with git config to your Apple Development certificate SHA-1.",
		);
	}
	return identity;
}

export function sign(app: string, identity: string, release = false): void {
	const bin = join(app, "Contents", "MacOS");
	const frameworks = join(app, "Contents", "Frameworks");
	const framework = join(frameworks, "Sparkle.framework");
	const version = join(framework, "Versions", "B");
	const options = release ? ["--options", "runtime", "--timestamp"] : [];
	const bundle = Bun.spawnSync([
		"/usr/bin/plutil",
		"-extract",
		"CFBundleIdentifier",
		"raw",
		"-o",
		"-",
		join(app, "Contents", "Info.plist"),
	]);
	if (!bundle.success) throw new Error("Cannot read the desktop bundle identifier for signing");
	const identifier = bundle.stdout.toString().trim();
	const { profile } = JSON.parse(
		readFileSync(join(app, "Contents", "Resources", "profile.json"), "utf8"),
	) as {
		profile?: string;
	};
	const client = profile
		? `${identifier}.${profile}.desktop-client`
		: `${identifier}.desktop-client`;
	// Sign nested code inside out. --deep is only appropriate for verification.
	for (
		const path of [
			join(version, "XPCServices", "Downloader.xpc"),
			join(version, "XPCServices", "Installer.xpc"),
			join(version, "Autoupdate"),
			join(version, "Updater.app"),
			framework,
		]
	) {
		run([
			"/usr/bin/codesign",
			"--force",
			"--sign",
			identity,
			"--preserve-metadata=entitlements",
			...options,
			path,
		]);
	}
	for (const file of readdirSync(frameworks).filter((name) => name.endsWith(".dylib"))) {
		run(["/usr/bin/codesign", "--force", "--sign", identity, ...options, join(frameworks, file)]);
	}
	const helpers = join(app, "Contents", "Helpers");
	for (const file of readdirSync(helpers)) {
		run(["/usr/bin/codesign", "--force", "--sign", identity, ...options, join(helpers, file)]);
	}
	const entitlements = fileURLToPath(new URL("../native/entitlements.plist", import.meta.url));
	for (const path of [...readdirSync(bin).map((file) => join(bin, file)), app]) {
		const desktop = path === join(bin, "ace-desktop-client");
		const gui = identifier === "dev.ace.desktop.dev"
			&& (path === join(bin, "bun") || path === join(bin, "launcher"));
		run([
			"/usr/bin/codesign",
			"--force",
			"--sign",
			identity,
			...options,
			...(desktop
				? ["--identifier", client]
				: gui
				? ["--identifier", identifier, "--entitlements", entitlements]
				: path.endsWith(".dylib")
				? []
				: ["--entitlements", entitlements]),
			path,
		]);
	}
	run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
}
