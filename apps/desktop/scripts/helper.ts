import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { version } from "../package.json";
import { notices } from "./notices";
import { run, sparkle } from "./sparkle";

const build = process.env.ELECTROBUN_BUILD_DIR;
const channel = process.env.ELECTROBUN_BUILD_ENV;
const identifier = process.env.ELECTROBUN_APP_IDENTIFIER;
if (!build || !channel || !identifier) throw new Error("Run this script through Electrobun");
if (process.env.ELECTROBUN_OS !== "macos") throw new Error("Ace Helper currently supports macOS");
const compiler = Bun.which("bun");
if (!compiler) throw new Error("Building Ace Helper requires Bun 1.4 or newer on PATH");
const runtime = Bun.spawnSync([compiler, "--version"]);
if (!runtime.success || !Bun.semver.satisfies(runtime.stdout.toString().trim(), ">=1.4.0")) {
	throw new Error("Building Ace Helper requires Bun 1.4 or newer on PATH for node:sqlite support");
}
const app = readdirSync(build).find((name) => name.endsWith(".app"));
if (!app) throw new Error("The Ace application bundle is missing");
const contents = join(build, app, "Contents");
const bin = join(contents, "MacOS");
// Runtime isolation must not change the macOS identity that owns development permissions.
const profile = channel === "dev" && !process.env.ACE_DEV_INSTALL
	? createHash("sha256").update(dirname(import.meta.dirname)).digest("hex").slice(0, 8)
	: undefined;
writeFileSync(join(contents, "Resources", "profile.json"), JSON.stringify({ profile }));
const native = fileURLToPath(new URL("../native", import.meta.url));
if (channel === "dev") {
	run([
		"xcrun",
		"clang",
		"-fobjc-arc",
		"-mmacosx-version-min=15.0",
		"-framework",
		"AppKit",
		join(native, "dev.m"),
		"-o",
		join(bin, "ace-dev-launcher"),
	]);
}
const swift = Bun.spawnSync(["xcrun", "swift", "--version"]);
const swiftVersion = /Swift version (\d+)\.(\d+)/.exec(swift.stdout.toString());
if (
	!swift.success || !swiftVersion || Number(swiftVersion[1]) < 6
	|| (Number(swiftVersion[1]) === 6 && Number(swiftVersion[2]) < 2)
) {
	throw new Error("Building native desktop inspection requires Xcode with Swift 6.2 or newer");
}
run([
	"/usr/bin/plutil",
	"-insert",
	"LSMinimumSystemVersion",
	"-string",
	"15.0",
	join(contents, "Info.plist"),
]);

// Only the helper needs node:sqlite; changing Electrobun's runtime breaks its native callbacks.
run([
	compiler,
	"build",
	fileURLToPath(new URL("../../host/src/helper.ts", import.meta.url)),
	"--compile",
	"--no-compile-autoload-dotenv",
	"--no-compile-autoload-bunfig",
	"--define",
	`ACE_IDENTIFIER=${JSON.stringify(identifier)}`,
	"--define",
	`ACE_PROFILE=${JSON.stringify(profile) || "undefined"}`,
	"--outfile",
	join(bin, "Ace Helper"),
]);
// Bun appends the embedded program after linking; refresh its local development signature.
run(["codesign", "--force", "--sign", "-", join(bin, "Ace Helper")]);

run([
	"xcrun",
	"clang",
	"-dynamiclib",
	"-fobjc-arc",
	"-mmacosx-version-min=15.0",
	"-framework",
	"Foundation",
	"-framework",
	"ServiceManagement",
	join(native, "service.m"),
	"-o",
	join(bin, "ace-service.dylib"),
]);

run([
	"xcrun",
	"clang",
	"-dynamiclib",
	"-fobjc-arc",
	"-mmacosx-version-min=15.0",
	"-framework",
	"Cocoa",
	"-framework",
	"QuartzCore",
	join(native, "window.m"),
	"-o",
	join(bin, "ace-window.dylib"),
]);

const sdk = await sparkle();
writeFileSync(
	join(contents, "Resources", "Sparkle-LICENSE.txt"),
	readFileSync(join(sdk, "LICENSE")),
);
const frameworks = join(contents, "Frameworks");
mkdirSync(frameworks, { recursive: true });
// The standalone package owns the pinned, patched native build; Ace signs and stages its outputs.
const tools = join(native, ".build", "desktop-tools");
const pkg = fileURLToPath(import.meta.resolve("@githubnext/desktop-tools/package.json"));
run([
	compiler,
	join(dirname(pkg), "dist", "build.js"),
	"--out",
	join(tools, "out"),
	"--scratch",
	join(tools, "scratch"),
]);
copyFileSync(join(tools, "out", "libDesktopTools.dylib"), join(bin, "libDesktopTools.dylib"));
copyFileSync(join(tools, "out", "desktop-tools-client"), join(bin, "ace-desktop-client"));
cpSync(join(tools, "out", "Licenses"), join(contents, "Resources", "Licenses"), {
	recursive: true,
});
const bundled = Bun.spawnSync([join(bin, "bun"), "--version"]).stdout.toString().trim();
await notices(contents, version, [
	`${runtime.stdout.toString().trim()} (Ace Helper)`,
	`${bundled} (desktop)`,
]);
run([
	"xcrun",
	"swiftc",
	"-emit-library",
	"-O",
	"-swift-version",
	"6",
	"-module-name",
	"AceProject",
	"-target",
	"arm64-apple-macos15.0",
	"-Xlinker",
	"-rpath",
	"-Xlinker",
	"@loader_path/../Frameworks",
	join(native, "project.swift"),
	"-o",
	join(bin, "libAceProject.dylib"),
]);
const binaries = ["libDesktopTools.dylib", "ace-desktop-client", "libAceProject.dylib"];
// Discover the runtimes from Mach-O dependencies instead of assuming a Swift library list.
run([
	"xcrun",
	"swift-stdlib-tool",
	"--copy",
	"--platform",
	"macosx",
	...binaries.flatMap((name) => ["--scan-executable", join(bin, name)]),
	"--destination",
	frameworks,
]);
run(["/usr/bin/ditto", join(sdk, "Sparkle.framework"), join(frameworks, "Sparkle.framework")]);
run([
	"xcrun",
	"clang",
	"-dynamiclib",
	"-fobjc-arc",
	"-mmacosx-version-min=15.0",
	"-framework",
	"Cocoa",
	"-F",
	sdk,
	"-framework",
	"Sparkle",
	"-Wl,-rpath,@loader_path/../Frameworks",
	join(native, "updates.m"),
	"-o",
	join(bin, "ace-updates.dylib"),
]);

if (channel !== "dev") {
	const origin = process.env.ACE_UPDATE_URL;
	const key = process.env.ACE_UPDATE_PUBLIC_KEY;
	if (!origin || !key || Buffer.from(key, "base64").length !== 32) {
		throw new Error("Release builds need ACE_UPDATE_URL and a valid ACE_UPDATE_PUBLIC_KEY");
	}
	const url = new URL(`${origin.replace(/\/$/, "")}/${channel}/macos-${process.arch}/appcast.xml`);
	if (url.protocol !== "https:") throw new Error("The release update URL must use HTTPS");
	const plist = join(contents, "Info.plist");
	for (
		const [name, type, value] of [
			["SUFeedURL", "string", url.href],
			["SUPublicEDKey", "string", key],
			["SURequireSignedFeed", "bool", "YES"],
			["SUVerifyUpdateBeforeExtraction", "bool", "YES"],
			["SUEnableAutomaticChecks", "bool", "YES"],
			["SUAllowsAutomaticUpdates", "bool", "NO"],
			["SUScheduledCheckInterval", "integer", "21600"],
		]
	) run(["/usr/bin/plutil", "-insert", name, `-${type}`, value, plist]);
}

const agents = join(contents, "Library", "LaunchAgents");
mkdirSync(agents, { recursive: true });
writeFileSync(
	join(agents, `${identifier}.helper.plist`),
	readFileSync(join(native, "helper.plist"), "utf8").replaceAll("dev.ace.desktop", identifier),
);
