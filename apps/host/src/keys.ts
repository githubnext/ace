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

/** What a keychain read waits on once it takes longer than a read without a macOS prompt. */
export const KEYCHAIN_WAITING = "Ace Helper is waiting for keychain access";

/** A macOS prompt holds a read until someone answers it, so concurrent readers share one prompt. */
const reading = new Map<string, Promise<string | undefined>>();

function keychain(name: string): Promise<string | undefined> {
	let read = reading.get(name);
	if (read) return read;
	// Resolve each request so running workers observe replacement and removal immediately.
	read = Bun.secrets.get({ service: config.keychain, name }).then(
		(value) => set(value ?? undefined),
		() => {
			throw new Error(
				`Cannot access ${name} in the keychain. Unlock it and allow Ace Helper, then retry.`,
			);
		},
	).finally(() => reading.delete(name));
	reading.set(name, read);
	return read;
}

export async function key(name: string): Promise<string | undefined> {
	return env(`ACE_${name}`) ?? env(name) ?? await keychain(name);
}

/** A read slower than this waited on something, usually a macOS prompt. */
const PROMPT = 50;

/** Each name's last finished status read, and whether it waited on a prompt. */
const known = new Map<string, { status: CredentialStatus; prompted: boolean }>();
/** When Ace Helper last saved or removed each name; a read started before then is stale. */
const changed = new Map<string, number>();

function change(name: string): void {
	known.delete(name);
	changed.set(name, performance.now());
}

export async function store(name: string, value: string): Promise<void> {
	await Bun.secrets.set({ service: config.keychain, name, value });
	change(name);
}

export async function forget(name: string): Promise<boolean> {
	const removed = await Bun.secrets.delete({ service: config.keychain, name });
	change(name);
	return removed;
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

/**
 * `credential` for Settings, which must not wait on a keychain prompt: a read still under way after
 * a moment answers with the last finished read, marked `waiting`, and a later call picks up its
 * result. Settings polls while it waits, so after a prompted read only `fresh` reads again, or each
 * poll would raise another prompt.
 */
export async function latest(name: string, fresh?: boolean): Promise<CredentialStatus> {
	const last = known.get(name);
	if (last?.prompted && !fresh && !reading.has(name)) return last.status;
	const started = performance.now();
	const read = credential(name).then((status) => {
		if (started > (changed.get(name) ?? 0)) {
			known.set(name, { status, prompted: performance.now() - started > PROMPT });
		}
		return status;
	});
	const status = await Promise.race([read, Bun.sleep(PROMPT)]);
	if (status) return status;
	const override = overriding(name);
	return {
		...last?.status ?? { source: override ? "environment" : "unavailable", stored: null, override },
		waiting: KEYCHAIN_WAITING,
	};
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
