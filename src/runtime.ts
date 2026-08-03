import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { MiniPieAgent } from "./agent.ts";
import { loadPrompt } from "./config.ts";
import { createModelRegistry, type ModelRegistry } from "./models.ts";
import { JsonlSession } from "./session.ts";
import { createDelegateTool, Semaphore } from "./subagent.ts";
import { createToolSet } from "./tools/index.ts";
import type {
	CreateAgentOptions,
	DefineAgentOptions,
	MiniPieConfig,
	MiniPieRuntimeOptions,
	RunResult,
	WorkflowResult,
} from "./types.ts";
import { runWorkflow } from "./workflow.ts";

export class MiniPieRuntime {
	readonly config: MiniPieConfig;
	readonly baseDir: string;
	readonly workspace: string;
	private readonly customTools: readonly AgentTool[];
	private readonly modelRegistry: ModelRegistry;
	private readonly subagentSemaphore = new Semaphore(2);

	private constructor(config: MiniPieConfig, options: MiniPieRuntimeOptions, workspace: string) {
		this.config = config;
		this.baseDir = resolve(options.baseDir ?? process.cwd());
		this.workspace = workspace;
		this.customTools = options.tools ?? [];
		this.modelRegistry = createModelRegistry(config.models);
	}

	static async create(config: MiniPieConfig, options: MiniPieRuntimeOptions = {}): Promise<MiniPieRuntime> {
		const baseDir = resolve(options.baseDir ?? process.cwd());
		const workspace = resolve(baseDir, config.workspace ?? ".");
		const workspaceStat = await stat(workspace);
		if (!workspaceStat.isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`);
		return new MiniPieRuntime(config, options, workspace);
	}

	async createAgent(name: string, options: CreateAgentOptions = {}, depth = 0): Promise<MiniPieAgent> {
		const definition = this.config.agents[name];
		if (!definition) throw new Error(`Unknown agent: ${name}`);
		const model = this.modelRegistry.byName.get(definition.model);
		if (!model) throw new Error(`Unknown model: ${definition.model}`);
		const systemPrompt = await loadPrompt(definition.systemPrompt, this.baseDir);
		const userPrompt = definition.userPrompt ? await loadPrompt(definition.userPrompt, this.baseDir) : undefined;
		const toolSet = createToolSet(definition.tools ?? [], this.workspace, this.customTools);
		const tools = [...toolSet.tools];
		if (depth === 0 && definition.subagents && definition.subagents.length > 0) {
			tools.push(
				createDelegateTool({
					allowedAgents: definition.subagents,
					semaphore: this.subagentSemaphore,
					run: async (subagentName, task, signal) => {
						const subagent = await this.createAgent(subagentName, {}, depth + 1);
						const onAbort = () => subagent.abort();
						signal?.addEventListener("abort", onAbort, { once: true });
						try {
							return (await subagent.run(task)).text;
						} finally {
							signal?.removeEventListener("abort", onAbort);
							await subagent.close();
						}
					},
				}),
			);
		}
		const sessionDirectory = options.sessionDir
			? resolve(options.sessionDir)
			: resolve(this.workspace, ".mini-pie", "sessions");
		const session = options.sessionId ? new JsonlSession(options.sessionId, sessionDirectory) : undefined;
		return MiniPieAgent.create({
			name,
			definition,
			systemPrompt,
			...(userPrompt !== undefined ? { userPrompt } : {}),
			workspace: this.workspace,
			models: this.modelRegistry.models,
			model,
			tools,
			disposeTools: toolSet.dispose,
			...(session ? { session } : {}),
		});
	}

	async runAgent(name: string, prompt: string, options: CreateAgentOptions = {}): Promise<RunResult> {
		const agent = await this.createAgent(name, options);
		try {
			return await agent.run(prompt);
		} finally {
			await agent.close();
		}
	}

	async runWorkflow(name: string, input: unknown): Promise<WorkflowResult> {
		const definition = this.config.workflows?.[name];
		if (!definition) throw new Error(`Unknown workflow: ${name}`);
		return runWorkflow({
			name,
			definition,
			input,
			baseDir: this.baseDir,
			runner: {
				runAgent: async (agent, prompt) => (await this.runAgent(agent, prompt)).text,
			},
		});
	}
}

export async function createRuntime(
	config: MiniPieConfig,
	options: MiniPieRuntimeOptions = {},
): Promise<MiniPieRuntime> {
	return MiniPieRuntime.create(config, options);
}

export async function defineAgent(options: DefineAgentOptions): Promise<MiniPieAgent> {
	const customTools: AgentTool[] = [];
	const toolNames = (options.tools ?? []).map((tool) => {
		if (typeof tool === "string") return tool;
		customTools.push(tool);
		return tool.name;
	});
	const config: MiniPieConfig = {
		version: 1,
		workspace: options.workspace ?? ".",
		models: { default: options.model },
		agents: {
			default: {
				model: "default",
				systemPrompt: options.systemPrompt,
				...(options.userPrompt !== undefined ? { userPrompt: options.userPrompt } : {}),
				tools: toolNames,
				...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
				...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
				...(options.maxToolCalls !== undefined ? { maxToolCalls: options.maxToolCalls } : {}),
				...(options.compaction !== undefined ? { compaction: options.compaction } : {}),
			},
		},
	};
	const runtime = await createRuntime(config, { tools: customTools });
	return runtime.createAgent("default", {
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
	});
}
