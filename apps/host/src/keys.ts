/**
 * Provider credentials. pi-ai asks for each by its usual environment name, such as
 * `OPENAI_API_KEY`; Ace answers from `ACE_<NAME>`, then `<NAME>`, then the OS keychain. The
 * keychain lets the desktop app, which starts without a shell's environment, find keys.
 */
import { access } from "node:fs/promises";
import { homedir } from "node:os";

import type { MutableModels } from "@earendil-works/pi-ai";
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

/** The environment variable that supplies `name` ahead of the keychain, if any. */
export function overriding(name: string): string | undefined {
	return env(`ACE_${name}`) ? `ACE_${name}` : env(name) ? name : undefined;
}

export async function credential(name: string): Promise<CredentialStatus> {
	const override = overriding(name);
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

/** pi-ai's built-in providers, resolving credentials through Ace. */
export function models(): MutableModels {
	return builtinModels({
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
