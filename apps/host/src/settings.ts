import type { ModelRef } from "@ace/channel/protocol";

import { config } from "./config";
import {
	credential,
	credentials,
	deviceId,
	forget,
	key,
	models as providerModels,
	store,
	subscriptions,
} from "./keys";
import { models, parseModel } from "./manage";
import { isModel, preference, savePreference } from "./preferences";
import type { ProviderId, Settings, Subscription } from "./protocol";

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

async function subscription(id: ProviderId): Promise<Subscription | undefined> {
	const name = subscriptions.get(id);
	if (!name) return;
	const pending = logins.get(id);
	try {
		const signedIn = (await credentials.read(id))?.type === "oauth";
		return { name, signedIn, login: pending && { url: pending.url, error: pending.error } };
	} catch (error) {
		return { name, signedIn: false, error: (error as Error).message };
	}
}

export async function settings(): Promise<Settings> {
	const statuses = await Promise.all(
		[...providers].map(async ([id, { name, key }]) =>
			Object.assign(await credential(key), { id, name, subscription: await subscription(id) })
		),
	);
	let available: ModelRef[] = [];
	let error: string | undefined;
	try {
		available = await models();
	} catch (cause) {
		error = (cause as Error).message;
	}
	return {
		providers: statuses,
		model: preference(),
		modelOverride: config.model ? parseModel(config.model) : undefined,
		models: available,
		error,
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

export async function setKey(id: ProviderId, value: string): Promise<void> {
	const selected = provider(id);
	if (
		typeof value !== "string" || !value.trim() || value.length > 4096 || /[\r\n]/.test(value)
		|| value.includes("\0")
	) {
		throw new Error("Enter a valid API key");
	}
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
		const available = await models();
		if (
			!available.some((item) => item.provider === model.provider && item.modelId === model.modelId)
		) {
			throw new Error("This model is unavailable. Add its provider key first.");
		}
	}
	savePreference(model);
}

type Login = {
	abort: AbortController;
	url?: string;
	error?: string;
	/** Settles the flow's prompt for a pasted redirect URL, which races its local callback. */
	paste?: (value: string) => void;
};

/** Sign-ins in progress, so any of the owner's windows can follow or finish one. */
const logins = new Map<ProviderId, Login>();

function subscriptionName(id: ProviderId): string {
	const name = subscriptions.get(id);
	if (!name) throw new Error(`${provider(id).name} has no subscription sign-in`);
	return name;
}

/** Resolves with the sign-in page once the flow is listening for its callback. */
export function startLogin(id: ProviderId, changed: () => void): Promise<string> {
	const name = subscriptionName(id);
	logins.get(id)?.abort.abort();
	const login: Login = { abort: new AbortController() };
	logins.set(id, login);
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	providerModels().login(id, "oauth", {
		signal: login.abort.signal,
		notify(event) {
			if (event.type !== "auth_url") return;
			login.url = event.url;
			resolve(event.url);
		},
		prompt(prompt) {
			if (prompt.type !== "manual_code") {
				return Promise.reject(new Error(`${name} sign-in asked for unsupported input`));
			}
			return new Promise((settle, fail) => {
				login.paste = settle;
				prompt.signal?.addEventListener("abort", () => fail(prompt.signal!.reason));
			});
		},
	}, { getDeviceId: deviceId }).then(
		() => {
			if (logins.get(id) === login) logins.delete(id);
			changed();
		},
		(error: Error) => {
			reject(error);
			if (logins.get(id) !== login) return;
			if (login.abort.signal.aborted) logins.delete(id);
			else login.error = error.message;
			changed();
		},
	);
	return promise;
}

/** For a browser on another machine, whose redirect cannot reach this host's callback. */
export function pasteLogin(id: ProviderId, value: string): void {
	const login = logins.get(id);
	if (!login?.paste) throw new Error(`Start signing in with ${subscriptionName(id)} first`);
	if (typeof value !== "string" || !value.trim() || value.length > 8192) {
		throw new Error("Paste the full address your browser ended on");
	}
	login.paste(value.trim());
}

export function cancelLogin(id: ProviderId): void {
	logins.get(id)?.abort.abort();
	logins.delete(id);
}

export async function logout(id: ProviderId): Promise<void> {
	cancelLogin(id);
	try {
		await credentials.delete(id);
	} catch {
		throw new Error(
			`Could not sign out of ${
				subscriptionName(id)
			}. Unlock the keychain and allow Ace Helper, then retry.`,
		);
	}
}
