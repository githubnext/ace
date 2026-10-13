import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function run(command: string[], options: { cwd?: string } = {}): void {
	// Bun's implicit child environment misses variables assigned while assembling a release.
	const result = Bun.spawnSync(command, {
		env: process.env,
		stdio: ["ignore", "inherit", "inherit"],
		...options,
	});
	if (!result.success) throw new Error(`${command[0]} failed with exit code ${result.exitCode}`);
}

/** Pin native downloads just as tightly as packages in bun.lock. */
async function pinned(name: string, version: string, url: string, checksum: string) {
	const cache = fileURLToPath(new URL(`../.tmp/${name}/${version}`, import.meta.url));
	if (existsSync(join(cache, ".verified"))) return cache;
	const temporary = `${cache}-${process.pid}`;
	mkdirSync(temporary, { recursive: true });
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
		if (!response.ok) throw new Error(`${name} download failed: ${response.status}`);
		const archive = Buffer.from(await response.arrayBuffer());
		if (createHash("sha256").update(archive).digest("hex") !== checksum) {
			throw new Error(`${name} checksum does not match the pinned release`);
		}
		const path = join(temporary, "archive");
		writeFileSync(path, archive);
		run(["/usr/bin/tar", "-xf", path, "-C", temporary]);
		rmSync(path);
		writeFileSync(join(temporary, ".verified"), checksum);
		renameSync(temporary, cache);
		return cache;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

export function sparkle(): Promise<string> {
	const version = "2.10.0";
	return pinned(
		"sparkle",
		version,
		`https://github.com/sparkle-project/Sparkle/releases/download/${version}/Sparkle-${version}.tar.xz`,
		"c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c",
	);
}

export const laneVersion = "0.2.0";

/** The lane CLI that channels create and land lanes with. */
export async function lane(): Promise<string> {
	const dir = await pinned(
		"lane",
		laneVersion,
		`https://github.com/lukeed/lane/releases/download/v${laneVersion}/lane-aarch64-apple-darwin.tar.gz`,
		"893a489ad28b1c9a730f334d503853b8bffbe6802287c8ecd08c398d9659ce82",
	);
	return join(dir, "lane");
}

if (import.meta.main) console.log(await sparkle());
