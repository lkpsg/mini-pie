import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import {
	type AgentWorkflowStep,
	type MiniPieConfig,
	type PromptSource,
	SUPPORTED_MODEL_APIS,
	type WorkflowStep,
} from "./types.ts";

export interface LoadedConfig {
	config: MiniPieConfig;
	filePath: string;
	baseDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
	throw new Error(`Invalid config at ${path}: ${message}`);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) fail(path, "expected an object");
	return value;
}

function requireString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) fail(path, "expected a non-empty string");
	return value;
}

function optionalPositiveInteger(value: unknown, path: string): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || (value as number) <= 0) fail(path, "expected a positive integer");
}

function optionalNonNegativeInteger(value: unknown, path: string): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || (value as number) < 0) fail(path, "expected a non-negative integer");
}

function validateStringArray(value: unknown, path: string): void {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
		fail(path, "expected an array of non-empty strings");
	}
}

function validatePromptSource(value: unknown, path: string): asserts value is PromptSource {
	if (typeof value === "string") return;
	const source = requireRecord(value, path);
	requireString(source.file, `${path}.file`);
}

function validateModels(value: unknown): void {
	const models = requireRecord(value, "models");
	if (Object.keys(models).length === 0) fail("models", "at least one model is required");
	for (const [name, value] of Object.entries(models)) {
		const path = `models.${name}`;
		const model = requireRecord(value, path);
		const api = requireString(model.api, `${path}.api`);
		if (!SUPPORTED_MODEL_APIS.includes(api as (typeof SUPPORTED_MODEL_APIS)[number])) {
			fail(`${path}.api`, `expected one of ${SUPPORTED_MODEL_APIS.join(", ")}`);
		}
		requireString(model.model, `${path}.model`);
		for (const key of ["provider", "baseUrl", "apiKeyEnv"] as const) {
			if (model[key] !== undefined) requireString(model[key], `${path}.${key}`);
		}
		if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") {
			fail(`${path}.reasoning`, "expected a boolean");
		}
		if (model.input !== undefined) {
			if (
				!Array.isArray(model.input) ||
				model.input.length === 0 ||
				model.input.some((item) => item !== "text" && item !== "image")
			) {
				fail(`${path}.input`, 'expected an array containing "text" and/or "image"');
			}
		}
		optionalPositiveInteger(model.contextWindow, `${path}.contextWindow`);
		optionalPositiveInteger(model.maxTokens, `${path}.maxTokens`);
		if (model.headers !== undefined) {
			const headers = requireRecord(model.headers, `${path}.headers`);
			for (const [header, headerValue] of Object.entries(headers)) {
				requireString(headerValue, `${path}.headers.${header}`);
			}
		}
	}
}

function validateCompaction(value: unknown, path: string): void {
	if (value === undefined) return;
	const compaction = requireRecord(value, path);
	if (compaction.enabled !== undefined && typeof compaction.enabled !== "boolean") {
		fail(`${path}.enabled`, "expected a boolean");
	}
	for (const key of [
		"pruneToolResultsAboveTokens",
		"summarizeAboveTokens",
		"keepRecentTokens",
		"reserveTokens",
	] as const) {
		optionalPositiveInteger(compaction[key], `${path}.${key}`);
	}
}

function validateAgents(value: unknown, models: Record<string, unknown>): void {
	const agents = requireRecord(value, "agents");
	if (Object.keys(agents).length === 0) fail("agents", "at least one agent is required");
	for (const [name, value] of Object.entries(agents)) {
		const path = `agents.${name}`;
		const agent = requireRecord(value, path);
		const model = requireString(agent.model, `${path}.model`);
		if (!(model in models)) fail(`${path}.model`, `unknown model "${model}"`);
		validatePromptSource(agent.systemPrompt, `${path}.systemPrompt`);
		if (agent.userPrompt !== undefined) validatePromptSource(agent.userPrompt, `${path}.userPrompt`);
		validateStringArray(agent.tools, `${path}.tools`);
		validateStringArray(agent.subagents, `${path}.subagents`);
		if (
			agent.thinking !== undefined &&
			!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(agent.thinking))
		) {
			fail(`${path}.thinking`, "invalid thinking level");
		}
		optionalPositiveInteger(agent.maxTurns, `${path}.maxTurns`);
		optionalPositiveInteger(agent.maxToolCalls, `${path}.maxToolCalls`);
		validateCompaction(agent.compaction, `${path}.compaction`);
	}
	for (const [name, value] of Object.entries(agents)) {
		const agent = value as Record<string, unknown>;
		for (const subagent of (agent.subagents as string[] | undefined) ?? []) {
			if (!(subagent in agents)) fail(`agents.${name}.subagents`, `unknown agent "${subagent}"`);
		}
	}
}

function validateCondition(value: unknown, path: string): void {
	if (value === undefined) return;
	const condition = requireRecord(value, path);
	requireString(condition.path, `${path}.path`);
	if (condition.exists !== undefined && typeof condition.exists !== "boolean") {
		fail(`${path}.exists`, "expected a boolean");
	}
	for (const key of ["equals", "notEquals"] as const) {
		const scalar = condition[key];
		if (scalar !== undefined && scalar !== null && !["string", "number", "boolean"].includes(typeof scalar)) {
			fail(`${path}.${key}`, "expected a scalar value");
		}
	}
}

function validateAgentStep(
	value: unknown,
	path: string,
	agents: Record<string, unknown>,
): asserts value is AgentWorkflowStep {
	const step = requireRecord(value, path);
	requireString(step.id, `${path}.id`);
	const agent = requireString(step.agent, `${path}.agent`);
	if (!(agent in agents)) fail(`${path}.agent`, `unknown agent "${agent}"`);
	validatePromptSource(step.prompt, `${path}.prompt`);
	validateCondition(step.when, `${path}.when`);
	optionalNonNegativeInteger(step.retry, `${path}.retry`);
}

function validateWorkflowStep(
	value: unknown,
	path: string,
	agents: Record<string, unknown>,
): asserts value is WorkflowStep {
	const step = requireRecord(value, path);
	if (step.parallel !== undefined) {
		if (!Array.isArray(step.parallel) || step.parallel.length === 0) {
			fail(`${path}.parallel`, "expected a non-empty array");
		}
		for (const [index, child] of step.parallel.entries()) {
			validateAgentStep(child, `${path}.parallel[${index}]`, agents);
		}
		return;
	}
	validateAgentStep(step, path, agents);
}

function validateWorkflows(value: unknown, agents: Record<string, unknown>): void {
	if (value === undefined) return;
	const workflows = requireRecord(value, "workflows");
	for (const [name, value] of Object.entries(workflows)) {
		const path = `workflows.${name}`;
		const workflow = requireRecord(value, path);
		if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
			fail(`${path}.steps`, "expected a non-empty array");
		}
		const ids = new Set<string>();
		workflow.steps.forEach((step, index) => {
			validateWorkflowStep(step, `${path}.steps[${index}]`, agents);
			const children = "parallel" in step ? step.parallel : [step];
			for (const child of children) {
				if (ids.has(child.id)) fail(`${path}.steps`, `duplicate step id "${child.id}"`);
				ids.add(child.id);
			}
		});
	}
}

function expandEnvironment(value: unknown, env: NodeJS.ProcessEnv, path = "config"): unknown {
	if (typeof value === "string") {
		return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
			const resolved = env[name];
			if (resolved === undefined) fail(path, `environment variable ${name} is not set`);
			return resolved;
		});
	}
	if (Array.isArray(value)) return value.map((item, index) => expandEnvironment(item, env, `${path}[${index}]`));
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, expandEnvironment(item, env, `${path}.${key}`)]),
		);
	}
	return value;
}

export function parseConfigText(text: string, env: NodeJS.ProcessEnv = process.env): MiniPieConfig {
	const expanded = expandEnvironment(parse(text) as unknown, env);
	const config = requireRecord(expanded, "config");
	if (config.version !== 1) fail("version", "expected 1");
	if (config.workspace !== undefined) requireString(config.workspace, "workspace");
	validateModels(config.models);
	const models = config.models as Record<string, unknown>;
	validateAgents(config.agents, models);
	validateWorkflows(config.workflows, config.agents as Record<string, unknown>);
	return config as unknown as MiniPieConfig;
}

export async function loadConfig(filePath: string): Promise<LoadedConfig> {
	const absolutePath = resolve(filePath);
	const text = await readFile(absolutePath, "utf8");
	return {
		config: parseConfigText(text),
		filePath: absolutePath,
		baseDir: dirname(absolutePath),
	};
}

export async function loadPrompt(source: PromptSource, baseDir: string): Promise<string> {
	if (typeof source === "string") return source;
	return readFile(resolve(baseDir, source.file), "utf8");
}

export function defineConfig<TConfig extends MiniPieConfig>(config: TConfig): TConfig {
	return config;
}
