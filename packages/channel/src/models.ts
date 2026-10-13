import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";

import type { ModelOption, ModelRef } from "./protocol";

const PREFERRED = ["anthropic/claude-opus-5-5", "openai/gpt-6-astra"];

/** One inaccessible provider must not hide another provider's usable models. */
export async function available(models: Models): Promise<ModelOption[]> {
	const results = await Promise.allSettled(
		models.getProviders().map((provider) => models.getAvailable(provider.id)),
	);
	const found = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
	const failed = results.find((result) => result.status === "rejected");
	if (!found.length && failed?.status === "rejected") throw failed.reason;
	return found.map((model) => ({
		provider: model.provider,
		modelId: model.id,
		efforts: getSupportedThinkingLevels(model),
	}));
}

export async function usable(models: Models, model: ModelRef): Promise<boolean> {
	const found = await models.getAvailable(model.provider);
	return found.some((value) => value.id === model.modelId);
}

/** Resolve an automatic choice only when admitting an agent invocation. */
export async function choose(models: Models): Promise<ModelRef> {
	const found = await available(models);
	const byId = new Map(found.map((model) => [`${model.provider}/${model.modelId}`, model]));
	const preferred = PREFERRED.find((id) => byId.has(id));
	const selected = preferred ? byId.get(preferred) : found[0];
	if (!selected) {
		throw new Error(
			"Add a provider key for this channel before invoking an agent. Chat is still available.",
		);
	}
	return { provider: selected.provider, modelId: selected.modelId };
}
