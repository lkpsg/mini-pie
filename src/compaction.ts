import {
	type AgentMessage,
	estimateContextTokens,
	estimateTokens,
	generateSummary,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { CompactionDefinition } from "./types.ts";

const REMOVED_TOOL_RESULT = "[Older tool result removed to reduce context size]";

function findRecentStart(messages: AgentMessage[], keepRecentTokens: number): number {
	let tokens = 0;
	let index = messages.length;
	while (index > 0 && tokens < keepRecentTokens) {
		index--;
		const message = messages[index];
		if (message) tokens += estimateTokens(message);
	}
	while (index < messages.length && messages[index]?.role !== "user") index++;
	return index < messages.length ? index : 0;
}

function pruneOldToolResults(messages: AgentMessage[], keepRecentTokens: number): AgentMessage[] {
	const recentStart = findRecentStart(messages, keepRecentTokens);
	return messages.map((message, index) => {
		if (index >= recentStart || message.role !== "toolResult") return message;
		return { ...message, content: [{ type: "text", text: REMOVED_TOOL_RESULT }] };
	});
}

export function createContextTransform(options: {
	models: Models;
	model: Model<Api>;
	thinking: ModelThinkingLevel;
	definition?: CompactionDefinition;
}): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
	const definition = options.definition;
	if (definition?.enabled === false) return async (messages) => messages;

	const keepRecentTokens = definition?.keepRecentTokens ?? 16_000;
	const reserveTokens = definition?.reserveTokens ?? 8_192;
	const pruneAbove = definition?.pruneToolResultsAboveTokens ?? Math.floor(options.model.contextWindow * 0.6);
	const summarizeAbove =
		definition?.summarizeAboveTokens ?? Math.max(pruneAbove + 1, options.model.contextWindow - reserveTokens);
	let cachedSummary: { key: string; text: string } | undefined;

	return async (messages, signal) => {
		const initialTokens = estimateContextTokens(messages).tokens;
		const pruned = initialTokens >= pruneAbove ? pruneOldToolResults(messages, keepRecentTokens) : messages;
		if (estimateContextTokens(pruned).tokens < summarizeAbove) return pruned;

		const recentStart = findRecentStart(pruned, keepRecentTokens);
		if (recentStart <= 0) return pruned;
		const history = pruned.slice(0, recentStart);
		const recent = pruned.slice(recentStart);
		const lastHistoryMessage = history.at(-1);
		const key = `${history.length}:${lastHistoryMessage?.timestamp ?? 0}:${estimateContextTokens(history).tokens}`;
		let summary = cachedSummary?.key === key ? cachedSummary.text : undefined;
		if (!summary) {
			const result = await generateSummary(
				history,
				options.models,
				options.model,
				reserveTokens,
				signal,
				"Preserve user requirements, decisions, file changes, tool findings, errors, and unresolved work.",
				undefined,
				options.thinking,
			);
			if (!result.ok) return pruned;
			summary = result.value;
			cachedSummary = { key, text: summary };
		}

		return [
			{
				role: "user",
				content: `Summary of earlier conversation:\n\n${summary}`,
				timestamp: Math.max(0, (recent[0]?.timestamp ?? Date.now()) - 1),
			},
			...recent,
		];
	};
}
