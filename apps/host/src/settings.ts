import type { ModelRef } from "@ace/channel/protocol";
import { available } from "@ace/channel/models";

import { config } from "./config";
import * as directory from "./directory";
import { forget, key, KEYCHAIN_WAITING, latest, overriding, settled, store } from "./keys";
import { models, parseModel } from "./manage";
import { canonical } from "./move";
import { isModel, preference, saveCompute, saveFolder, savePreference } from "./preferences";
import type { Compute, Invite, ProviderId, Settings } from "./protocol";

const providers = new Map(
	[
		["anthropic", {
			name: "Anthropic",
			key: "ANTHROPIC_API_KEY",
			url: "https://api.anthropic.com/v1/models?limit=1",
		}],
		["openai", { name: "OpenAI", key: "OPENAI_API_KEY", url: "https://api.openai.com/v1/models" }],
	] as const,
);

function provider(id: ProviderId) {
	const found = providers.get(id);
	if (!found) throw new Error("Choose Anthropic or OpenAI");
	return found;
}

/** Settings never waits on a keychain prompt; `fresh` reads again names whose last read prompted. */
export async function settings(fresh?: boolean): Promise<Settings> {
	const catalog = settled(fresh);
	const [statuses, usable] = await Promise.all([
		Promise.all(
			[...providers].map(async ([id, { name, key }]) =>
				Object.assign(await latest(key, fresh), { id, name })
			),
		),
		available(catalog.models).catch((error: Error) => error),
	]);
	return {
		providers: statuses,
		model: preference(),
		modelOverride: config.model ? parseModel(config.model) : undefined,
		models: usable instanceof Error ? [] : usable,
		waiting: catalog.waiting() ? KEYCHAIN_WAITING : undefined,
		error: usable instanceof Error ? usable.message : undefined,
	};
}

async function check(id: ProviderId, value: string): Promise<void> {
	const selected = provider(id);
	const headers: Record<string, string> = id === "anthropic"
		? { "x-api-key": value, "anthropic-version": "2023-06-01" }
		: { authorization: `Bearer ${value}` };
	let response: Response;
	try {
		response = await fetch(selected.url, {
			headers,
			signal: AbortSignal.timeout(10_000),
			redirect: "error",
		});
	} catch {
		throw new Error(`Could not reach ${selected.name}. Check your connection and try again.`);
	}
	// Provider errors can echo credentials. Only status codes leave the host.
	await response.body?.cancel();
	if (response.ok) return;
	if (response.status === 401) throw new Error(`${selected.name} rejected this API key.`);
	if (response.status === 403) {
		throw new Error(
			`${selected.name} denied access. Check this key's permissions for listing models.`,
		);
	}
	if (response.status === 429) {
		throw new Error(`${selected.name} is rate limiting requests. Try again shortly.`);
	}
	throw new Error(`${selected.name} could not check the key (HTTP ${response.status}). Try again.`);
}

function isValue(value: unknown): value is string {
	return typeof value === "string" && !!value.trim() && value.length <= 4096
		&& !/[\r\n]/.test(value) && !value.includes("\0");
}

export async function setKey(id: ProviderId, value: string): Promise<void> {
	const selected = provider(id);
	if (!isValue(value)) throw new Error("Enter a valid API key");
	value = value.trim();
	await check(id, value);
	try {
		await store(selected.key, value);
	} catch {
		throw new Error(
			`Could not save the ${selected.name} key. Unlock the keychain and allow Ace Helper, then retry.`,
		);
	}
}

export async function checkKey(id: ProviderId): Promise<void> {
	const selected = provider(id);
	const value = await key(selected.key);
	if (!value) throw new Error(`Add a ${selected.name} API key first.`);
	await check(id, value);
}

export async function removeKey(id: ProviderId): Promise<void> {
	const selected = provider(id);
	try {
		await forget(selected.key);
	} catch {
		throw new Error(
			`Could not remove the ${selected.name} key. Unlock the keychain and allow Ace Helper, then retry.`,
		);
	}
}

export async function setModel(model: ModelRef | null): Promise<void> {
	if (model !== null) {
		if (!isModel(model)) throw new Error("Choose a provider and model");
		const found = await models();
		if (
			!found.some((item) => item.provider === model.provider && item.modelId === model.modelId)
		) {
			throw new Error("This model is unavailable. Add its provider key first.");
		}
	}
	savePreference(model);
}

export function setCompute({ enabled, url }: Compute): void {
	if (typeof enabled !== "boolean") throw new Error("Turn cloud compute on or off");
	const service = url?.trim() ? canonical(url.trim()) : null;
	if (enabled && !service) throw new Error("Add the cloud compute service URL first");
	saveCompute({ enabled, url: service });
}

export function setFolder(value: string): void {
	const path = value.trim().replace(/(.)\/+$/, "$1");
	if (!isValue(path) || !/^(?:~(?:\/|$)|\/)/.test(path)) {
		throw new Error("Enter a full folder path, such as ~/code");
	}
	saveFolder(path);
}

function named(name: unknown): void {
	if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
		throw new Error("Name a key such as OPENAI_API_KEY");
	}
}

/**
 * Keychain items saved through Ace Helper, so it can read them later without a macOS prompt: an
 * item saved by another program, such as a CLI's Bun or `security`, asks before Ace Helper reads it.
 */
export async function storeKey(name: string, value: string): Promise<void> {
	named(name);
	if (!isValue(value)) throw new Error(`Enter a valid ${name}`);
	try {
		await store(name, value.trim());
	} catch {
		throw new Error(
			`Could not save ${name}. Unlock the keychain and allow Ace Helper, then retry.`,
		);
	}
}

export async function forgetKey(name: string): Promise<boolean> {
	named(name);
	try {
		return await forget(name);
	} catch {
		throw new Error(
			`Could not remove ${name}. Unlock the keychain and allow Ace Helper, then retry.`,
		);
	}
}

/** What a teammate needs to join: this host's directory and the secret it was joined with. */
export async function invite(): Promise<Invite> {
	const url = directory.url();
	const secret = await key("ACE_SECRET");
	if (!url || !secret) throw new Error("Join the team's directory first");
	return { url, secret };
}

/**
 * Join the team's directory, or leave it when `url` is null. A new secret replaces the saved
 * ACE_SECRET only after the directory accepts it; without one, the saved secret must work.
 */
export async function setDirectory(url: string | null, secret?: string): Promise<void> {
	if (url === null) return directory.configure(undefined);
	const base = directory.canonical(url);
	if (secret !== undefined && !isValue(secret)) throw new Error("Enter the team's shared secret");
	const override = secret !== undefined && overriding("ACE_SECRET");
	if (override) {
		throw new Error(
			`${override} in Ace Helper's environment takes priority over a saved secret. Remove it and restart Ace Helper first.`,
		);
	}
	const value = secret?.trim() || await key("ACE_SECRET");
	if (!value) throw new Error("Enter the team's shared secret");
	await directory.check(base, value);
	if (secret !== undefined) await storeKey("ACE_SECRET", value);
	await directory.configure(base);
}
