import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, contentText, type Model, type Models } from "@earendil-works/pi-ai";
import { AsyncQueue } from "./async-queue.ts";
import { createContextTransform } from "./compaction.ts";
import type { JsonlSession } from "./session.ts";
import type { AgentDefinition, MiniPieEvent, RunResult } from "./types.ts";
import { guardToolPath } from "./workspace.ts";

export class AgentRunError extends Error {
	readonly result: RunResult;

	constructor(result: RunResult) {
		super(result.message.errorMessage || `Agent stopped with reason: ${result.message.stopReason}`);
		this.name = "AgentRunError";
		this.result = result;
	}
}

function finalAssistantMessage(messages: AgentMessage[]): AssistantMessage {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") return message;
	}
	throw new Error("Agent completed without an assistant message");
}

function applyUserPrompt(template: string | undefined, input: string): string {
	if (!template) return input;
	if (template.includes("{{input}}")) return template.replaceAll("{{input}}", input);
	return `${template}\n\n${input}`;
}

export interface MiniPieAgentOptions {
	name: string;
	definition: AgentDefinition;
	systemPrompt: string;
	userPrompt?: string;
	workspace: string;
	models: Models;
	model: Model<Api>;
	tools: AgentTool[];
	disposeTools: () => Promise<void>;
	session?: JsonlSession;
}

export class MiniPieAgent {
	readonly name: string;
	readonly sessionId: string | undefined;
	private readonly agent: Agent;
	private readonly disposeTools: () => Promise<void>;
	private readonly userPrompt: string | undefined;
	private readonly unsubscribeRuntime: () => void;
	private closed = false;

	private constructor(options: MiniPieAgentOptions, initialMessages: AgentMessage[]) {
		this.name = options.name;
		this.sessionId = options.session?.id;
		this.disposeTools = options.disposeTools;
		this.userPrompt = options.userPrompt;
		let turnCount = 0;
		let toolCallCount = 0;
		const maxTurns = options.definition.maxTurns ?? 32;
		const maxToolCalls = options.definition.maxToolCalls ?? 64;

		this.agent = new Agent({
			initialState: {
				systemPrompt: options.systemPrompt,
				model: options.model,
				thinkingLevel: options.definition.thinking ?? "off",
				tools: options.tools,
				messages: initialMessages,
			},
			streamFn: options.models.streamSimple.bind(options.models),
			transformContext: createContextTransform({
				models: options.models,
				model: options.model,
				thinking: options.definition.thinking ?? "off",
				...(options.definition.compaction ? { definition: options.definition.compaction } : {}),
			}),
			toolExecution: "parallel",
			maxRetryDelayMs: 60_000,
			beforeToolCall: async ({ toolCall, args }) => {
				toolCallCount++;
				if (toolCallCount > maxToolCalls) {
					return { block: true, reason: `Maximum tool calls exceeded (${maxToolCalls})` };
				}
				try {
					await guardToolPath(options.workspace, toolCall.name, args);
				} catch (error) {
					return { block: true, reason: error instanceof Error ? error.message : String(error) };
				}
			},
		});

		this.unsubscribeRuntime = this.agent.subscribe(async (event) => {
			if (event.type === "agent_start") {
				turnCount = 0;
				toolCallCount = 0;
			} else if (event.type === "turn_start") {
				turnCount++;
				if (turnCount > maxTurns) throw new Error(`Maximum agent turns exceeded (${maxTurns})`);
			} else if (event.type === "message_end" && options.session) {
				await options.session.append(event.message);
			}
		});
	}

	static async create(options: MiniPieAgentOptions): Promise<MiniPieAgent> {
		const initialMessages = options.session ? await options.session.load() : [];
		return new MiniPieAgent(options, initialMessages);
	}

	get messages(): readonly AgentMessage[] {
		return this.agent.state.messages;
	}

	get isRunning(): boolean {
		return this.agent.state.isStreaming;
	}

	abort(): void {
		this.agent.abort();
	}

	async run(input: string): Promise<RunResult> {
		let result: RunResult | undefined;
		for await (const event of this.stream(input)) {
			if (event.type === "end") result = event.result;
		}
		if (!result) throw new Error("Agent stream ended without a result");
		if (result.message.stopReason === "error" || result.message.stopReason === "aborted") {
			throw new AgentRunError(result);
		}
		return result;
	}

	async *stream(input: string): AsyncGenerator<MiniPieEvent> {
		if (this.closed) throw new Error("Agent is closed");
		const queue = new AsyncQueue<MiniPieEvent>();
		const unsubscribe = this.agent.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				queue.push({ type: "text_delta", delta: event.assistantMessageEvent.delta });
			} else if (event.type === "tool_execution_start") {
				queue.push({
					type: "tool_start",
					id: event.toolCallId,
					name: event.toolName,
					arguments: event.args as unknown,
				});
			} else if (event.type === "tool_execution_update") {
				queue.push({
					type: "tool_update",
					id: event.toolCallId,
					name: event.toolName,
					update: event.partialResult as unknown,
				});
			} else if (event.type === "tool_execution_end") {
				queue.push({
					type: "tool_end",
					id: event.toolCallId,
					name: event.toolName,
					result: event.result as unknown,
					isError: event.isError,
				});
			} else if (event.type === "agent_end") {
				const messages = this.agent.state.messages.slice();
				const message = finalAssistantMessage(messages);
				queue.push({
					type: "end",
					result: {
						agent: this.name,
						text: contentText(message.content),
						message,
						messages,
						...(this.sessionId ? { sessionId: this.sessionId } : {}),
					},
				});
			}
		});

		queue.push({ type: "start", agent: this.name, ...(this.sessionId ? { sessionId: this.sessionId } : {}) });
		const promptPromise = this.agent
			.prompt(applyUserPrompt(this.userPrompt, input))
			.then(() => queue.end())
			.catch((error: unknown) => queue.fail(error));

		try {
			for await (const event of queue) yield event;
			await promptPromise;
		} finally {
			unsubscribe();
			if (this.agent.state.isStreaming) this.agent.abort();
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.agent.abort();
		await this.agent.waitForIdle();
		this.unsubscribeRuntime();
		await this.disposeTools();
	}
}
