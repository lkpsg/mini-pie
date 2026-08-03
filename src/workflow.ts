import { loadPrompt } from "./config.ts";
import type {
	AgentWorkflowStep,
	WorkflowCondition,
	WorkflowDefinition,
	WorkflowResult,
	WorkflowStepResult,
} from "./types.ts";

export interface WorkflowAgentRunner {
	runAgent(agent: string, prompt: string): Promise<string>;
}

interface WorkflowContext {
	input: unknown;
	steps: Record<string, WorkflowStepResult>;
}

function valueAtPath(root: unknown, path: string): unknown {
	let current = root;
	for (const part of path.split(".")) {
		if (typeof current !== "object" || current === null || !(part in current)) return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function renderValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function renderTemplate(template: string, context: WorkflowContext): string {
	return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, path: string) => {
		const value = valueAtPath(context, path.trim());
		if (value === undefined) throw new Error(`Workflow template value was not found: ${path.trim()}`);
		return renderValue(value);
	});
}

function conditionMatches(condition: WorkflowCondition | undefined, context: WorkflowContext): boolean {
	if (!condition) return true;
	const value = valueAtPath(context, condition.path);
	if (condition.exists !== undefined && condition.exists !== (value !== undefined)) return false;
	if (condition.equals !== undefined && value !== condition.equals) return false;
	if (condition.notEquals !== undefined && value === condition.notEquals) return false;
	if (condition.exists === undefined && condition.equals === undefined && condition.notEquals === undefined) {
		return Boolean(value);
	}
	return true;
}

async function executeStep(
	step: AgentWorkflowStep,
	context: WorkflowContext,
	baseDir: string,
	runner: WorkflowAgentRunner,
): Promise<WorkflowStepResult> {
	if (!conditionMatches(step.when, context)) return { id: step.id, agent: step.agent, output: "", attempts: 0 };
	const template = await loadPrompt(step.prompt, baseDir);
	const prompt = renderTemplate(template, context);
	const maximumAttempts = (step.retry ?? 0) + 1;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
		try {
			const output = await runner.runAgent(step.agent, prompt);
			return { id: step.id, agent: step.agent, output, attempts: attempt };
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

export async function runWorkflow(options: {
	name: string;
	definition: WorkflowDefinition;
	input: unknown;
	baseDir: string;
	runner: WorkflowAgentRunner;
}): Promise<WorkflowResult> {
	const context: WorkflowContext = { input: options.input, steps: {} };
	let output = "";
	for (const step of options.definition.steps) {
		if ("parallel" in step) {
			const snapshot: WorkflowContext = { input: context.input, steps: { ...context.steps } };
			const results = await Promise.all(
				step.parallel.map((child) => executeStep(child, snapshot, options.baseDir, options.runner)),
			);
			for (const result of results) {
				context.steps[result.id] = result;
				output = result.output;
			}
		} else {
			const result = await executeStep(step, context, options.baseDir, options.runner);
			context.steps[result.id] = result;
			output = result.output;
		}
	}
	return { workflow: options.name, output, steps: context.steps };
}
