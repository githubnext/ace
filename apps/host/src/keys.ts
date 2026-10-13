/**
 * Provider credentials. pi-ai asks for each by its usual environment name, such as
 * `OPENAI_API_KEY`; Ace answers from `ACE_<NAME>`, then `<NAME>`, then the OS keychain. The
 * keychain lets the desktop app, which starts without a shell's environment, find keys.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Credential, CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { config } from "./config";
import type { CredentialStatus } from "./protocol";

const sealed = new Map<string, string>();

/**
 * Agent shells inherit the worker's environment, and anyone admitted to a channel can run
 * `env` through its agent. Credentials leave `process.env` before any tool runs and stay
 * readable only through `key`.
 */
const secret = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?)$/;

export function seal(): void {
	for (const [name, value] of Object.entries(process.env)) {
		if (!secret.test(name) || value === undefined) continue;
		sealed.set(name, value);
		delete process.env[name];
	}
}

/** Only channel workers receive these values; each seals them before running tools. */
export function workerEnv(): NodeJS.ProcessEnv {
	return { ...process.env, ...Object.fromEntries(sealed) };
}

/** GitHub CLI receives only its own sealed credentials, not model provider keys. */
export function githubEnv(): NodeJS.ProcessEnv {
	const token = env("GH_TOKEN") || env("GITHUB_TOKEN");
	return token ? { GH_TOKEN: token } : {};
}

function env(name: string): string | undefined {
	return set(sealed.get(name) ?? process.env[name]);
}

function set(value: string | undefined): string | undefined {
	return value?.trim() ? value : undefined;
}

async function keychain(name: string): Promise<string | undefined> {
	try {
		// Resolve each request so running workers observe replacement and removal immediately.
		return set(await Bun.secrets.get({ service: config.keychain, name }) ?? undefined);
	} catch {
		throw new Error(
			`Cannot access ${name} in the keychain. Unlock it and allow Ace Helper, then retry.`,
		);
	}
}

export async function key(name: string): Promise<string | undefined> {
	return env(`ACE_${name}`) ?? env(name) ?? await keychain(name);
}

export function store(name: string, value: string): Promise<void> {
	return Bun.secrets.set({ service: config.keychain, name, value });
}

export async function forget(name: string): Promise<boolean> {
	return Bun.secrets.delete({ service: config.keychain, name });
}

export async function credential(name: string): Promise<CredentialStatus> {
	const override = env(`ACE_${name}`) ? `ACE_${name}` : env(name) ? name : undefined;
	try {
		const stored = !!await keychain(name);
		return { source: override ? "environment" : stored ? "keychain" : "missing", stored, override };
	} catch (error) {
		return {
			source: override ? "environment" : "unavailable",
			stored: null,
			override,
			error: (error as Error).message,
		};
	}
}

// The compiled helper and workers cannot follow pi-ai's lazy imports of its sign-in flows.
registerBunOAuthFlows();

/** Providers whose subscription sign-in Ace offers, by pi-ai provider ID. */
export const subscriptions = new Map([["openai", "ChatGPT"]]);

function oauthName(provider: string): string {
	return `${provider.toUpperCase().replaceAll("-", "_")}_OAUTH`;
}

async function signedIn(provider: string): Promise<Credential | undefined> {
	if (!subscriptions.has(provider)) return;
	const value = await keychain(oauthName(provider));
	return value ? JSON.parse(value) as Credential : undefined;
}

/**
 * Workers refresh subscription tokens independently, and providers rotate refresh tokens, so a
 * refresh holds an exclusive SQLite lock across processes. The kernel releases it if one crashes.
 */
async function exclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	mkdirSync(config.settings, { recursive: true, mode: 0o700 });
	const db = new Database(join(config.settings, "credentials.lock"));
	try {
		for (;;) {
			signal?.throwIfAborted();
			try {
				db.run("BEGIN EXCLUSIVE");
				break;
			} catch (error) {
				if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
				await Bun.sleep(50);
			}
		}
		return await fn();
	} finally {
		db.close();
	}
}

/** Only subscription sign-ins live here; API keys resolve through `key`. */
export const credentials: CredentialStore = {
	read: (provider) => signedIn(provider),
	async list() {
		const found = await Promise.all(
			[...subscriptions.keys()].map(async (providerId) =>
				await signedIn(providerId) ? { providerId, type: "oauth" as const } : undefined
			),
		);
		return found.filter((info) => info !== undefined);
	},
	modify(provider, fn, options) {
		if (!subscriptions.has(provider)) {
			return Promise.reject(new Error(`Ace stores no ${provider} credentials`));
		}
		return exclusive(async () => {
			const next = await fn(await signedIn(provider));
			if (next) await store(oauthName(provider), JSON.stringify(next));
			return next || await signedIn(provider);
		}, options?.signal);
	},
	async delete(provider) {
		if (subscriptions.has(provider)) await exclusive(() => forget(oauthName(provider)));
	},
};

/** OpenAI identifies each installation that signs in with ChatGPT by a stable ID. */
export function deviceId(): string {
	const path = join(config.settings, "device-id");
	try {
		return readFileSync(path, "utf8").trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const id = randomUUID();
	mkdirSync(config.settings, { recursive: true, mode: 0o700 });
	writeFileSync(path, id, { mode: 0o600, flag: "wx" });
	return id;
}

/** pi-ai's built-in providers, resolving credentials through Ace. */
export function models(): MutableModels {
	return builtinModels({
		credentials,
		authContext: {
			env: key,
			async fileExists(path) {
				try {
					await access(path.startsWith("~") ? homedir() + path.slice(1) : path);
					return true;
				} catch {
					return false;
				}
			},
		},
	});
}
