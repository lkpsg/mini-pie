import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";

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

export interface WorkflowCondition {
	path: string;
	exists?: boolean;
	equals?: ConditionScalar;
	notEquals?: ConditionScalar;
}

export interface AgentWorkflowStep {
	id: string;
	agent: string;
	prompt: PromptSource;
	when?: WorkflowCondition;
	retry?: number;
}

export interface ParallelWorkflowStep {
	parallel: AgentWorkflowStep[];
}

export type WorkflowStep = AgentWorkflowStep | ParallelWorkflowStep;

export interface WorkflowDefinition {
	steps: WorkflowStep[];
}

export interface MiniPieConfig {
	version: 1;
	workspace?: string;
	models: Record<string, ModelDefinition>;
	agents: Record<string, AgentDefinition>;
	workflows?: Record<string, WorkflowDefinition>;
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

export interface MiniPieRuntimeOptions {
	baseDir?: string;
	tools?: AgentTool[];
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

export interface WorkflowStepResult {
	id: string;
	agent: string;
	output: string;
	attempts: number;
}

export interface WorkflowResult {
	workflow: string;
	output: string;
	steps: Record<string, WorkflowStepResult>;
}
