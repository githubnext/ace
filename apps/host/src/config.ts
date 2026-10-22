import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const settings = process.platform === "darwin"
	? join(homedir(), "Library", "Application Support", "Ace")
	: join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ace");

/** Capture host configuration before credentials leave the process environment. */
export const config = {
	home: resolve(process.env.ACE_HOME || join(homedir(), ".local", "state", "ace")),
	settings: resolve(process.env.ACE_CONFIG_HOME || settings),
	keychain: process.env.ACE_KEYCHAIN_SERVICE || "ace",
	user: process.env.ACE_USER,
	model: process.env.ACE_MODEL,
	port: Number(process.env.ACE_PORT || 4140),
	/** HTTPS for browsers on the tailnet; defaults to port + 1000. */
	webPort: process.env.ACE_WEB_PORT ? Number(process.env.ACE_WEB_PORT) : undefined,
	peerPort: process.env.ACE_PEER_PORT ? Number(process.env.ACE_PEER_PORT) : undefined,
	app: fileURLToPath(new URL("../../app/dist", import.meta.url)),
	/** The team's Cloudflare services: sources in a checkout, prebuilt bundles in the app. */
	services: fileURLToPath(new URL("../../../services", import.meta.url)),
	appUrl: process.env.ACE_APP_URL,
	helper: false,
	/** Ace Helper's app version, reported by /health so a conflict can name the build on the port. */
	version: undefined as string | undefined,
	/** Set by ace serve --loopback; the host stays off the tailnet and the team directory. */
	loopback: false,
	worker: [
		process.execPath,
		"--no-env-file",
		fileURLToPath(new URL("./worker.ts", import.meta.url)),
	] as [string, ...string[]],
};

const ports: Record<string, number> = { dev: 4141, canary: 4142 };

/**
 * Canary, the installed development app, and each checkout's development build own separate
 * channels, settings, credentials, and listeners. Checkout profiles come from signed build
 * metadata rather than the macOS permission identity. Their apps must not manage Ace Helper.
 */
export function desktop(identifier: string, profile?: string): string | undefined {
	if (
		profile !== undefined
		&& (identifier !== "dev.ace.desktop.dev" || !/^[a-f0-9]{8}$/.test(profile))
	) {
		throw new Error(
			"Only development builds can use a checkout profile of eight lowercase hex digits",
		);
	}
	const name = profile
		? `dev-${profile}`
		: identifier.slice("dev.ace.desktop.".length).replaceAll(".", "-");
	if (!name) return;
	// A profile exported for another app must never point a checkout's build at that app's data.
	if (profile || !process.env.ACE_HOME) {
		config.home = join(homedir(), ".local", "state", `ace-${name}`);
	}
	if (profile || !process.env.ACE_CONFIG_HOME) config.settings = `${settings}-${name}`;
	if (profile || !process.env.ACE_KEYCHAIN_SERVICE) config.keychain = `ace-${name}`;
	if (!process.env.ACE_PORT) {
		config.port = ports[name] || 4200 + Number.parseInt(profile || "0", 16) % 800;
	}
	return profile;
}
