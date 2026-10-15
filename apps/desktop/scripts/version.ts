import { fileURLToPath } from "node:url";

import { version as base } from "../package.json";

export type Version = { bundle: string; display: string };

/** Bundle versions Ace has shipped: x.y.z, with canary's build number appended. */
export const bundlePattern = /^\d+\.\d+\.\d+(\.[1-9]\d*)?$/;

// Sparkle orders updates by bundle version alone, so canary appends an increasing build number to
// ship without a package bump; the SHA is display-only because commits don't order.
export function version(channel: string, build?: string, revision?: string): Version {
	if (!/^\d+\.\d+\.\d+$/.test(base)) throw new Error("Use an incrementing x.y.z desktop version");
	if (channel !== "canary") return { bundle: base, display: base };
	if (!build || !/^[1-9]\d*$/.test(build)) {
		throw new Error("Set ACE_BUILD_NUMBER to a build number above every published canary's");
	}
	if (!revision || !/^[a-f0-9]{40}$/.test(revision)) {
		throw new Error("A canary version needs its full source revision");
	}
	return { bundle: `${base}.${build}`, display: `${base}+${revision.slice(0, 7)}` };
}

export function current(channel: string): Version {
	if (channel !== "canary") return version(channel);
	const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
		cwd: fileURLToPath(new URL("..", import.meta.url)),
	});
	if (!head.success) throw new Error("Cannot determine the canary's source revision");
	return version(channel, process.env.ACE_BUILD_NUMBER, head.stdout.toString().trim());
}

/** Sparkle's order for numeric versions: a longer version is newer when the shared parts match. */
export function order(a: string, b: string): number {
	const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
	for (let index = 0; index < Math.max(x.length, y.length); index++) {
		if (x[index] === undefined) return -1;
		if (y[index] === undefined) return 1;
		if (x[index] !== y[index]) return x[index]! - y[index]!;
	}
	return 0;
}
