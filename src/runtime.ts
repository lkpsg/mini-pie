import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { MiniPieAgent } from "./agent.ts";
import { CodeNodeLoader } from "./code-node.ts";
import { loadPrompt } from "./config.ts";
import { GraphExecutor } from "./graph.ts";
import { JsonlGraphRunStore } from "./graph-store.ts";
import { createModelRegistry, type ModelRegistry } from "./models.ts";
import { JsonlSession } from "./session.ts";
import { createDelegateTool, Semaphore } from "./subagent.ts";
import { createToolSet } from "./tools/index.ts";
import type {
	AgentDefinition,
	CreateAgentOptions,
	DefineAgentOptions,
	GraphRunResult,
	LoadedUnit,
	MiniPieConfig,
	MiniPieRuntimeOptions,
	ReviewDecision,
	RunResult,
	RunUnitOptions,
	UnitDefinition,
} from "./types.ts";
import { graphForUnit, UnitRegistry } from "./units.ts";

function agentInput(value: unknown): string {
	if (typeof value === "string") return value;
	const serialized = JSON.stringify(value, null, 2);
	return serialized ?? "null";
}

export class MiniPieRuntime {
	readonly config: MiniPieConfig;
	readonly baseDir: string;
	readonly workspace: string;
	private readonly customTools: readonly AgentTool[];
	private readonly modelRegistry: ModelRegistry;
	private readonly subagentSemaphore = new Semaphore(2);
	private readonly units: UnitRegistry;
	private readonly runStore: JsonlGraphRunStore;
	private readonly codeNodes = new CodeNodeLoader();
	private readonly reviewHandler: MiniPieRuntimeOptions["reviewHandler"];

	private constructor(config: MiniPieConfig, options: MiniPieRuntimeOptions, workspace: string, units: UnitRegistry) {
		this.config = config;
		this.baseDir = resolve(options.baseDir ?? process.cwd());
		this.workspace = workspace;
		this.customTools = options.tools ?? [];
		this.modelRegistry = createModelRegistry(config.models);
		this.units = units;
		this.reviewHandler = options.reviewHandler;
		this.runStore = new JsonlGraphRunStore(resolve(workspace, config.storage?.directory ?? ".mini-pie/runs"));
	}

	static async create(config: MiniPieConfig, options: MiniPieRuntimeOptions = {}): Promise<MiniPieRuntime> {
		const baseDir = resolve(options.baseDir ?? process.cwd());
		const workspace = resolve(baseDir, config.workspace ?? ".");
		const workspaceStat = await stat(workspace);
		if (!workspaceStat.isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`);
		const units = await UnitRegistry.load(config, baseDir);
		return new MiniPieRuntime(config, options, workspace, units);
	}

	listUnits(kind?: UnitDefinition["kind"]): LoadedUnit[] {
		return this.units.list(kind);
	}

	async createAgent(name: string, options: CreateAgentOptions = {}, depth = 0): Promise<MiniPieAgent> {
		const unit = this.units.get(name);
		if (unit.definition.kind !== "agent") throw new Error(`Unit is not an agent: ${name}`);
		const definition = unit.definition;
		const model = this.modelRegistry.byName.get(definition.model);
		if (!model) throw new Error(`Unknown model: ${definition.model}`);
		const systemPrompt = await loadPrompt(definition.systemPrompt, unit.directory);
		const userPrompt = definition.userPrompt ? await loadPrompt(definition.userPrompt, unit.directory) : undefined;
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

	async runAgent(
		name: string,
		prompt: string,
		options: CreateAgentOptions = {},
		signal?: AbortSignal,
	): Promise<RunResult> {
		const agent = await this.createAgent(name, options);
		const onAbort = () => agent.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			if (signal?.aborted) agent.abort();
			return await agent.run(prompt);
		} finally {
			signal?.removeEventListener("abort", onAbort);
			await agent.close();
		}
	}

	private createGraphExecutor(unit: LoadedUnit, signal?: AbortSignal): GraphExecutor {
		return new GraphExecutor({
			unit: unit.name,
			definition: graphForUnit(unit),
			unitDirectory: unit.directory,
			store: this.runStore,
			runner: {
				runAgent: async (name, input, nodeSignal) =>
					(await this.runAgent(name, agentInput(input), {}, nodeSignal)).text,
				runCode: (options) => this.codeNodes.run(options),
			},
			...(signal ? { signal } : {}),
		});
	}

	private async handleReviews(result: GraphRunResult, signal?: AbortSignal): Promise<GraphRunResult> {
		let current = result;
		while (current.status === "waiting_review" && current.review && this.reviewHandler) {
			const decision = await this.reviewHandler.review(current.review);
			const snapshot = await this.runStore.load(current.runId);
			const unit = this.units.get(snapshot.unit);
			current = await this.createGraphExecutor(unit, signal).resume(snapshot, decision);
		}
		return current;
	}

	async runUnit(name: string, input: unknown, options: RunUnitOptions = {}): Promise<GraphRunResult> {
		const unit = this.units.get(name);
		const result = await this.createGraphExecutor(unit, options.signal).start({
			input,
			...(options.initialState ? { initialState: options.initialState } : {}),
			...(options.runId ? { runId: options.runId } : {}),
		});
		return this.handleReviews(result, options.signal);
	}

	async runWorkflow(name: string, input: unknown, options: RunUnitOptions = {}): Promise<GraphRunResult> {
		return this.runUnit(name, input, options);
	}

	async resume(runId: string, decision: ReviewDecision, signal?: AbortSignal): Promise<GraphRunResult> {
		const snapshot = await this.runStore.load(runId);
		const unit = this.units.get(snapshot.unit);
		const result = await this.createGraphExecutor(unit, signal).resume(snapshot, decision);
		return this.handleReviews(result, signal);
	}
}

export async function createRuntime(
	config: MiniPieConfig,
	options: MiniPieRuntimeOptions = {},
): Promise<MiniPieRuntime> {
	return MiniPieRuntime.create(config, options);
}

export async function defineAgent(options: DefineAgentOptions): Promise<MiniPieAgent> {
	const workspace = resolve(options.workspace ?? ".");
	const workspaceStat = await stat(workspace);
	if (!workspaceStat.isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`);
	const customTools: AgentTool[] = [];
	const toolNames = (options.tools ?? []).map((tool) => {
		if (typeof tool === "string") return tool;
		customTools.push(tool);
		return tool.name;
	});
	const registry = createModelRegistry({ default: options.model });
	const model = registry.byName.get("default");
	if (!model) throw new Error("Default model was not registered");
	const toolSet = createToolSet(toolNames, workspace, customTools);
	const definition: AgentDefinition = {
		model: "default",
		systemPrompt: options.systemPrompt,
		...(options.userPrompt !== undefined ? { userPrompt: options.userPrompt } : {}),
		tools: toolNames,
		...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
		...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
		...(options.maxToolCalls !== undefined ? { maxToolCalls: options.maxToolCalls } : {}),
		...(options.compaction !== undefined ? { compaction: options.compaction } : {}),
	};
	const sessionDirectory = options.sessionDir
		? resolve(options.sessionDir)
		: resolve(workspace, ".mini-pie", "sessions");
	const session = options.sessionId ? new JsonlSession(options.sessionId, sessionDirectory) : undefined;
	return MiniPieAgent.create({
		name: "default",
		definition,
		systemPrompt: options.systemPrompt,
		...(options.userPrompt !== undefined ? { userPrompt: options.userPrompt } : {}),
		workspace,
		models: registry.models,
		model,
		tools: toolSet.tools,
		disposeTools: toolSet.dispose,
		...(session ? { session } : {}),
	});
}
