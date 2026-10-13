/** Writes the third-party notices for exactly the packages and native components Ace.app ships. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { laneVersion } from "./downloads";

type Section = { name: string; version?: string; license?: string; texts: string[] };

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const vendored = fileURLToPath(new URL("../licenses", import.meta.url));
const notice = /^(licen[cs]e|copying|notice)([.-]|$)/i;
// Tailwind inlines these through CSS @import, so they never appear in Rollup's module graph.
const css = ["tailwindcss", "tw-animate-css", "shadcn"];

function root(path: string): string | undefined {
	const at = path.lastIndexOf("node_modules/");
	if (at < 0) return;
	const parts = path.slice(at + "node_modules/".length).split("/");
	return path.slice(0, at) + "node_modules/"
		+ parts.slice(0, parts[0]!.startsWith("@") ? 2 : 1).join("/");
}

function texts(dir: string): string[] {
	return readdirSync(dir).filter((file) => notice.test(file)).sort().map((file) =>
		readFileSync(join(dir, file), "utf8").trim()
	);
}

function vendor(...files: string[]): string[] {
	return files.map((file) => readFileSync(join(vendored, file), "utf8").trim());
}

// Apache-2.0 requires its text with every copy, even when a package omits the file.
function fallback(pkg: { name: string; license?: string }, own: string[]): string[] {
	if (own.length) return own;
	if (pkg.name === "electrobun") return vendor("electrobun.txt");
	if (pkg.license?.toLowerCase() === "apache-2.0") return vendor("apache-2.0.txt");
	return own;
}

async function bunModules(): Promise<string[]> {
	const result = await Bun.build({
		entrypoints: [join(repo, "apps/host/src/helper.ts"), join(repo, "apps/desktop/src/index.ts")],
		target: "bun",
		metafile: true,
	});
	if (!result.success || !result.metafile) {
		throw new Error("Could not read the native module graph");
	}
	// Metafile inputs are relative to the working directory, which Electrobun sets to apps/desktop.
	return Object.keys(result.metafile.inputs).map((path) => resolve(path));
}

function webModules(): string[] {
	const app = join(repo, "apps/app");
	const files = JSON.parse(readFileSync(join(app, "dist/.vite/modules.json"), "utf8")) as string[];
	const ui = join(repo, "packages/ui/package.json");
	return [
		...files.map((file) => join(app, file)),
		...css.map((name) => dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`, ui)))),
	];
}

function packages(paths: string[]): Section[] {
	const dirs = new Set(paths.map(root).filter((dir) => dir !== undefined));
	const found = new Map<string, Section>();
	for (const dir of dirs) {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
			name: string;
			version: string;
			license?: string;
		};
		if (pkg.name.startsWith("@ace/")) continue;
		const key = `${pkg.name}@${pkg.version}`;
		if (found.has(key)) continue;
		found.set(key, {
			name: pkg.name,
			version: pkg.version,
			license: pkg.license,
			texts: fallback(pkg, texts(dir)),
		});
	}
	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function escape(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function render(version: string, sections: Section[]): string {
	const seen = new Map<string, string>();
	const body = sections.map(({ name, version, license, texts }) => {
		const title = escape(version ? `${name} ${version}` : name);
		const blocks = texts.map((text) => {
			const first = seen.get(text);
			if (first) return `<p>Same text as ${escape(first)}.</p>`;
			seen.set(text, title);
			return `<pre>${escape(text)}</pre>`;
		});
		if (!blocks.length) blocks.push("<p>The package publishes no license file.</p>");
		return `<h2>${title}</h2>${license ? `<p>${escape(license)}</p>` : ""}${blocks.join("")}`;
	});
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Ace third-party notices</title>
<style>body{font:14px/1.5 -apple-system,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem}
h2{font-size:1rem;margin:2rem 0 .25rem}pre{white-space:pre-wrap;font-size:12px;background:#f5f5f5;padding:.75rem}
@media(prefers-color-scheme:dark){body{background:#1c1c1c;color:#ddd}pre{background:#2a2a2a}}</style>
</head><body><h1>Ace ${escape(version)} third-party notices</h1>
<p>Ace is open source software under the MIT license. This build includes the software below.</p>
${body.join("\n")}
</body></html>
`;
}

/** Writes notices.html and the About panel's Credits.html into the bundle's Resources. */
export async function notices(
	contents: string,
	version: string,
	runtimes: string[],
): Promise<void> {
	const resources = join(contents, "Resources");
	const licenses = join(resources, "Licenses");
	const native: Section[] = [
		{
			name: "Ace",
			version,
			license: "MIT",
			texts: [readFileSync(join(repo, "LICENSE"), "utf8").trim()],
		},
		{ name: "Bun", version: runtimes.join(", "), texts: vendor("bun.md") },
		{
			name: "Sparkle",
			texts: [readFileSync(join(resources, "Sparkle-LICENSE.txt"), "utf8").trim()],
		},
		{
			name: "zig-bsdiff (Electrobun bspatch)",
			license: "MIT",
			texts: vendor("zig-bsdiff.txt", "bsdiff.txt"),
		},
		{
			name: "zig-zstd (Electrobun zstd)",
			license: "MIT",
			texts: vendor("zig-zstd.txt", "zstd.txt"),
		},
		{ name: "zig-asar (Electrobun libasar)", license: "MIT", texts: [] },
		{ name: "lane", version: laneVersion, license: "MIT", texts: vendor("lane.txt") },
		// desktop-tools stages one directory of notices per native component it links.
		...readdirSync(licenses).sort().map((name) => ({ name, texts: texts(join(licenses, name)) })),
	];
	const sections = [...native, ...packages([...await bunModules(), ...webModules()])];
	writeFileSync(join(resources, "notices.html"), render(version, sections));
	writeFileSync(
		join(resources, "Credits.html"),
		`<p style="font:11px -apple-system;text-align:center">Open source under the MIT license.<br>
<a href="notices.html">Third-party notices</a> &middot; <a href="https://github.com/githubnext/ace2">Source</a></p>`,
	);
}
