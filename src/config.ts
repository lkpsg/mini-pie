import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import type {
	CodeHookDefinition,
	GraphCondition,
	GraphNodeDefinition,
	MiniPieConfig,
	NodeReviewDefinition,
	PromptSource,
	UnitDefinition,
} from "./types.ts";
import { SUPPORTED_MODEL_APIS } from "./types.ts";

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

function validateId(value: string, path: string): void {
	if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(value)) {
		fail(path, "expected an identifier containing letters, numbers, underscores, or hyphens");
	}
}

function optionalString(value: unknown, path: string): void {
	if (value !== undefined) requireString(value, path);
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

function validateModels(value: unknown): Record<string, unknown> {
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
		for (const key of ["provider", "baseUrl", "apiKeyEnv"] as const) optionalString(model[key], `${path}.${key}`);
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
	return models;
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

function validateReview(value: unknown, path: string): asserts value is NodeReviewDefinition | undefined {
	if (value === undefined) return;
	const review = requireRecord(value, path);
	for (const phase of ["before", "after"] as const) {
		if (review[phase] !== undefined && typeof review[phase] !== "boolean") {
			fail(`${path}.${phase}`, "expected a boolean");
		}
	}
	optionalString(review.message, `${path}.message`);
}

function validateCondition(value: unknown, path: string): asserts value is GraphCondition | undefined {
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

function validateCommonNode(node: Record<string, unknown>, path: string): void {
	optionalNonNegativeInteger(node.retry, `${path}.retry`);
	optionalPositiveInteger(node.timeoutMs, `${path}.timeoutMs`);
	optionalString(node.concurrencyKey, `${path}.concurrencyKey`);
	if (node.join !== undefined && node.join !== "all" && node.join !== "any") {
		fail(`${path}.join`, 'expected "all" or "any"');
	}
	if (node.edgeMode !== undefined && node.edgeMode !== "first" && node.edgeMode !== "all") {
		fail(`${path}.edgeMode`, 'expected "first" or "all"');
	}
	validateReview(node.review, `${path}.review`);
}

function validateNode(value: unknown, path: string): asserts value is GraphNodeDefinition {
	const node = requireRecord(value, path);
	validateCommonNode(node, path);
	if (node.type === "agent") {
		requireString(node.unit, `${path}.unit`);
		return;
	}
	if (node.type === "code") {
		requireString(node.entry, `${path}.entry`);
		return;
	}
	fail(`${path}.type`, 'expected "agent" or "code"');
}

function validateHook(value: unknown, path: string): asserts value is CodeHookDefinition {
	const hook = requireRecord(value, path);
	validateId(requireString(hook.id, `${path}.id`), `${path}.id`);
	requireString(hook.entry, `${path}.entry`);
	optionalNonNegativeInteger(hook.retry, `${path}.retry`);
	optionalPositiveInteger(hook.timeoutMs, `${path}.timeoutMs`);
	validateReview(hook.review, `${path}.review`);
}

function validateHooks(value: unknown, path: string): void {
	if (value === undefined) return;
	const hooks = requireRecord(value, path);
	const ids = new Set<string>();
	for (const phase of ["before", "after"] as const) {
		const entries = hooks[phase];
		if (entries === undefined) continue;
		if (!Array.isArray(entries)) fail(`${path}.${phase}`, "expected an array");
		for (const [index, entry] of entries.entries()) {
			validateHook(entry, `${path}.${phase}[${index}]`);
			if (entry.id === "agent") fail(`${path}.${phase}[${index}].id`, '"agent" is reserved');
			if (ids.has(entry.id)) fail(path, `duplicate hook id "${entry.id}"`);
			ids.add(entry.id);
		}
	}
}

function validateAgentUnit(unit: Record<string, unknown>, path: string, models: Record<string, unknown>): void {
	const model = requireString(unit.model, `${path}.model`);
	if (!(model in models)) fail(`${path}.model`, `unknown model "${model}"`);
	validatePromptSource(unit.systemPrompt, `${path}.systemPrompt`);
	if (unit.userPrompt !== undefined) validatePromptSource(unit.userPrompt, `${path}.userPrompt`);
	validateStringArray(unit.tools, `${path}.tools`);
	validateStringArray(unit.subagents, `${path}.subagents`);
	if (
		unit.thinking !== undefined &&
		!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(unit.thinking))
	) {
		fail(`${path}.thinking`, "invalid thinking level");
	}
	optionalPositiveInteger(unit.maxTurns, `${path}.maxTurns`);
	optionalPositiveInteger(unit.maxToolCalls, `${path}.maxToolCalls`);
	validateCompaction(unit.compaction, `${path}.compaction`);
	validateHooks(unit.hooks, `${path}.hooks`);
	validateReview(unit.review, `${path}.review`);
}

function validateGraphUnit(unit: Record<string, unknown>, path: string): void {
	const nodes = requireRecord(unit.nodes, `${path}.nodes`);
	if (Object.keys(nodes).length === 0) fail(`${path}.nodes`, "at least one node is required");
	for (const [id, node] of Object.entries(nodes)) {
		validateId(id, `${path}.nodes.${id}`);
		validateNode(node, `${path}.nodes.${id}`);
	}

	if (unit.entry !== undefined) {
		const entries = typeof unit.entry === "string" ? [unit.entry] : unit.entry;
		if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => typeof entry !== "string")) {
			fail(`${path}.entry`, "expected a node id or a non-empty array of node ids");
		}
		for (const entry of entries) if (!(entry in nodes)) fail(`${path}.entry`, `unknown node "${entry}"`);
	}

	if (unit.edges !== undefined) {
		if (!Array.isArray(unit.edges)) fail(`${path}.edges`, "expected an array");
		for (const [index, value] of unit.edges.entries()) {
			const edgePath = `${path}.edges[${index}]`;
			const edge = requireRecord(value, edgePath);
			const from = requireString(edge.from, `${edgePath}.from`);
			const to = requireString(edge.to, `${edgePath}.to`);
			if (!(from in nodes)) fail(`${edgePath}.from`, `unknown node "${from}"`);
			if (!(to in nodes)) fail(`${edgePath}.to`, `unknown node "${to}"`);
			validateCondition(edge.when, `${edgePath}.when`);
		}
	}
	optionalPositiveInteger(unit.maxSteps, `${path}.maxSteps`);
	optionalPositiveInteger(unit.maxVisits, `${path}.maxVisits`);
	optionalPositiveInteger(unit.maxConcurrency, `${path}.maxConcurrency`);
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
	if (config.version !== 2) fail("version", "expected 2");
	if (config.workspace !== undefined) requireString(config.workspace, "workspace");
	validateModels(config.models);
	if (config.storage !== undefined) {
		const storage = requireRecord(config.storage, "storage");
		optionalString(storage.directory, "storage.directory");
	}
	const units = requireRecord(config.units, "units");
	if (Object.keys(units).length === 0) fail("units", "at least one unit is required");
	for (const [name, registration] of Object.entries(units)) {
		validateId(name, `units.${name}`);
		if (typeof registration === "string") {
			requireString(registration, `units.${name}`);
		} else {
			const record = requireRecord(registration, `units.${name}`);
			requireString(record.path, `units.${name}.path`);
		}
	}
	return config as unknown as MiniPieConfig;
}

export function parseUnitText(
	text: string,
	models: Record<string, unknown>,
	env: NodeJS.ProcessEnv = process.env,
	path = "unit",
): UnitDefinition {
	const expanded = expandEnvironment(parse(text) as unknown, env, path);
	const unit = requireRecord(expanded, path);
	optionalString(unit.description, `${path}.description`);
	if (unit.kind === "agent") validateAgentUnit(unit, path, models);
	else if (unit.kind === "graph") validateGraphUnit(unit, path);
	else fail(`${path}.kind`, 'expected "agent" or "graph"');
	return unit as unknown as UnitDefinition;
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
