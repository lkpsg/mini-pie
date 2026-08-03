import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ModelThinkingLevel, Static, TSchema } from "@earendil-works/pi-ai";

export const SUPPORTED_MODEL_APIS = ["openai-responses", "anthropic-messages", "openai-completions"] as const;

export type SupportedModelApi = (typeof SUPPORTED_MODEL_APIS)[number];

export const BUILTIN_TOOL_NAMES = [
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
	"apply_patch",
	"http_request",
	"sleep",
	"todo",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export interface ModelDefinition {
	api: SupportedModelApi;
	model: string;
	provider?: string;
	baseUrl?: string;
	apiKeyEnv?: string;
	headers?: Record<string, string>;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	contextWindow?: number;
	maxTokens?: number;
}

export type PromptSource = string | { file: string };

export interface CompactionDefinition {
	enabled?: boolean;
	pruneToolResultsAboveTokens?: number;
	summarizeAboveTokens?: number;
	keepRecentTokens?: number;
	reserveTokens?: number;
}

export interface AgentDefinition {
	model: string;
	systemPrompt: PromptSource;
	userPrompt?: PromptSource;
	tools?: string[];
	subagents?: string[];
	thinking?: ModelThinkingLevel;
	maxTurns?: number;
	maxToolCalls?: number;
	compaction?: CompactionDefinition;
}

export type ConditionScalar = string | number | boolean | null;

export interface GraphCondition {
	path: string;
	exists?: boolean;
	equals?: ConditionScalar;
	notEquals?: ConditionScalar;
}

export interface ValueReference {
	$ref: string;
}

export type BindingValue = ConditionScalar | ValueReference | BindingValue[] | { [key: string]: BindingValue };

export interface NodeReviewDefinition {
	before?: boolean;
	after?: boolean;
	message?: string;
}

export interface GraphNodeBase {
	input?: BindingValue;
	retry?: number;
	timeoutMs?: number;
	concurrencyKey?: string;
	join?: "all" | "any";
	edgeMode?: "first" | "all";
	review?: NodeReviewDefinition;
}

export interface AgentGraphNodeDefinition extends GraphNodeBase {
	type: "agent";
	unit: string;
}

export interface CodeGraphNodeDefinition extends GraphNodeBase {
	type: "code";
	entry: string;
	params?: BindingValue;
}

export type GraphNodeDefinition = AgentGraphNodeDefinition | CodeGraphNodeDefinition;

export interface GraphEdgeDefinition {
	from: string;
	to: string;
	when?: GraphCondition;
}

export interface GraphUnitDefinition {
	kind: "graph";
	description?: string;
	entry?: string | string[];
	nodes: Record<string, GraphNodeDefinition>;
	edges?: GraphEdgeDefinition[];
	output?: BindingValue;
	initialState?: Record<string, BindingValue>;
	maxSteps?: number;
	maxVisits?: number;
	maxConcurrency?: number;
}

export interface CodeHookDefinition {
	id: string;
	entry: string;
	input?: BindingValue;
	params?: BindingValue;
	retry?: number;
	timeoutMs?: number;
	review?: NodeReviewDefinition;
}

export interface AgentHooksDefinition {
	before?: CodeHookDefinition[];
	after?: CodeHookDefinition[];
}

export interface AgentUnitDefinition extends AgentDefinition {
	kind: "agent";
	description?: string;
	hooks?: AgentHooksDefinition;
	review?: NodeReviewDefinition;
}

export type UnitDefinition = AgentUnitDefinition | GraphUnitDefinition;

export interface StorageDefinition {
	directory?: string;
}

export interface MiniPieConfig {
	version: 2;
	workspace?: string;
	models: Record<string, ModelDefinition>;
	storage?: StorageDefinition;
	units: Record<string, string | { path: string }>;
}

export interface LoadedUnit {
	name: string;
	directory: string;
	filePath: string;
	definition: UnitDefinition;
}

export interface CreateAgentOptions {
	sessionId?: string;
	sessionDir?: string;
}

export interface DefineAgentOptions
	extends Omit<AgentDefinition, "model" | "systemPrompt" | "userPrompt" | "tools" | "subagents"> {
	model: ModelDefinition;
	systemPrompt: string;
	userPrompt?: string;
	tools?: Array<BuiltinToolName | AgentTool>;
	workspace?: string;
	sessionId?: string;
	sessionDir?: string;
}

export type ReviewAction = "approve" | "retry" | "edit" | "skip" | "abort" | "override" | "takeover";
export type ReviewPhase = "before" | "after";

export interface ReviewDecision {
	action: ReviewAction;
	value?: unknown;
	statePatch?: Record<string, unknown>;
	note?: string;
}

export interface ReviewRequest {
	checkpointId: string;
	runId: string;
	unit: string;
	node: string;
	phase: ReviewPhase;
	visit: number;
	message?: string;
	input: unknown;
	output?: unknown;
}

export interface ReviewHandler {
	review(request: ReviewRequest): Promise<ReviewDecision>;
}

export interface MiniPieRuntimeOptions {
	baseDir?: string;
	tools?: AgentTool[];
	reviewHandler?: ReviewHandler;
}

export interface RunUnitOptions {
	runId?: string;
	initialState?: Record<string, unknown>;
	signal?: AbortSignal;
}

export type MiniPieEvent =
	| { type: "start"; agent: string; sessionId?: string }
	| { type: "text_delta"; delta: string }
	| { type: "tool_start"; id: string; name: string; arguments: unknown }
	| { type: "tool_update"; id: string; name: string; update: unknown }
	| { type: "tool_end"; id: string; name: string; result: unknown; isError: boolean }
	| { type: "end"; result: RunResult };

export interface RunResult {
	agent: string;
	text: string;
	message: AssistantMessage;
	messages: AgentMessage[];
	sessionId?: string;
}

export type GraphNodeStatus =
	| "pending"
	| "running"
	| "waiting_review"
	| "succeeded"
	| "failed"
	| "skipped"
	| "cancelled";

export type GraphRunStatus = "running" | "waiting_review" | "succeeded" | "failed" | "aborted";

export interface GraphNodeResult {
	id: string;
	type: "agent" | "code";
	status: GraphNodeStatus;
	visit: number;
	attempts: number;
	output?: unknown;
	statePatch?: Record<string, unknown>;
	error?: string;
	startedAt: string;
	completedAt: string;
}

export interface GraphNodeRuntimeState {
	status: GraphNodeStatus;
	visits: number;
	attempts: number;
}

export interface GraphRuntimeContext {
	runId: string;
	unit: string;
	status: GraphRunStatus;
	step: number;
	visits: Record<string, number>;
	node?: string;
	visit?: number;
}

export interface GraphRunResult {
	runId: string;
	unit: string;
	status: GraphRunStatus;
	output?: unknown;
	state: Record<string, unknown>;
	results: Record<string, GraphNodeResult>;
	runtime: GraphRuntimeContext;
	review?: ReviewRequest;
	error?: string;
}

export type WorkflowResult = GraphRunResult;

export interface CodeNodeRunContext<TInput = unknown, TParams = unknown> {
	input: TInput;
	params: TParams;
	state: Readonly<Record<string, unknown>>;
	signal: AbortSignal;
	runtime: Readonly<GraphRuntimeContext>;
}

export interface CodeNodeRunResult<TOutput = unknown> {
	output: TOutput;
	statePatch?: Record<string, unknown>;
}

export interface CodeNodeDefinition<
	TInputSchema extends TSchema = TSchema,
	TOutputSchema extends TSchema = TSchema,
	TParamsSchema extends TSchema = TSchema,
> {
	input: TInputSchema;
	output: TOutputSchema;
	params?: TParamsSchema;
	run(
		context: CodeNodeRunContext<Static<TInputSchema>, Static<TParamsSchema>>,
	): Promise<CodeNodeRunResult<Static<TOutputSchema>>> | CodeNodeRunResult<Static<TOutputSchema>>;
}
