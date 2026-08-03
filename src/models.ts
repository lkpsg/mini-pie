import {
	type Api,
	createModels,
	createProvider,
	envApiKeyAuth,
	type Model,
	type Models,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ModelDefinition, SupportedModelApi } from "./types.ts";

export interface ModelRegistry {
	models: Models;
	byName: ReadonlyMap<string, Model<Api>>;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function defaultBaseUrl(api: SupportedModelApi): string {
	return api === "anthropic-messages" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
}

function defaultApiKeyEnvironment(api: SupportedModelApi): string {
	return api === "anthropic-messages" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
}

function defaultProvider(name: string, api: SupportedModelApi): string {
	if (api === "openai-responses") return "openai";
	if (api === "anthropic-messages") return "anthropic";
	return name;
}

function apiStreams(api: SupportedModelApi): ProviderStreams {
	switch (api) {
		case "openai-responses":
			return openAIResponsesApi();
		case "anthropic-messages":
			return anthropicMessagesApi();
		case "openai-completions":
			return openAICompletionsApi();
	}
}

function createModel(name: string, definition: ModelDefinition): Model<Api> {
	return {
		id: definition.model,
		name: definition.model,
		api: definition.api,
		provider: definition.provider ?? defaultProvider(name, definition.api),
		baseUrl: definition.baseUrl ?? defaultBaseUrl(definition.api),
		reasoning: definition.reasoning ?? false,
		input: definition.input ?? ["text"],
		cost: ZERO_COST,
		contextWindow: definition.contextWindow ?? 128_000,
		maxTokens: definition.maxTokens ?? 16_384,
		...(definition.headers ? { headers: definition.headers } : {}),
	};
}

export function createModelRegistry(definitions: Record<string, ModelDefinition>): ModelRegistry {
	const models = createModels();
	const byName = new Map<string, Model<Api>>();
	const groups = new Map<string, Array<{ definition: ModelDefinition; model: Model<Api> }>>();
	for (const [name, definition] of Object.entries(definitions)) {
		const model = createModel(name, definition);
		const group = groups.get(model.provider) ?? [];
		group.push({ definition, model });
		groups.set(model.provider, group);
		byName.set(name, model);
	}

	for (const [providerId, group] of groups) {
		const first = group[0];
		if (!first) continue;
		const apiKeyEnvironment = first.definition.apiKeyEnv ?? defaultApiKeyEnvironment(first.definition.api);
		for (const entry of group.slice(1)) {
			const candidate = entry.definition.apiKeyEnv ?? defaultApiKeyEnvironment(entry.definition.api);
			if (candidate !== apiKeyEnvironment) {
				throw new Error(`Models sharing provider "${providerId}" must use the same apiKeyEnv`);
			}
		}
		const streams = Object.fromEntries(
			group.map(({ definition }) => [definition.api, apiStreams(definition.api)]),
		) as Partial<Record<Api, ProviderStreams>>;
		models.setProvider(
			createProvider({
				id: providerId,
				name: providerId,
				baseUrl: first.model.baseUrl,
				auth: {
					apiKey: envApiKeyAuth(`${providerId} API key`, [apiKeyEnvironment]),
				},
				models: group.map(({ model }) => model),
				api: streams,
			}),
		);
	}
	return { models, byName };
}
