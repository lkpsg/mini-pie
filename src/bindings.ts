import type { BindingValue, GraphCondition, GraphNodeResult, GraphRuntimeContext } from "./types.ts";

export interface GraphBindingContext {
	input: unknown;
	state: Record<string, unknown>;
	results: Record<string, GraphNodeResult>;
	runtime: GraphRuntimeContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function valueAtPath(root: unknown, path: string): unknown {
	let current = root;
	if (path.length === 0) return current;
	for (const part of path.split(".")) {
		if (Array.isArray(current)) {
			const index = Number(part);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
			current = current[index];
			continue;
		}
		if (!isRecord(current) || !(part in current)) return undefined;
		current = current[part];
	}
	return current;
}

export function resolveBindings(value: BindingValue, context: GraphBindingContext): unknown {
	if (Array.isArray(value)) return value.map((item) => resolveBindings(item, context));
	if (!isRecord(value)) return value;
	if (Object.keys(value).length === 1 && typeof value.$ref === "string") {
		const resolved = valueAtPath(context, value.$ref);
		if (resolved === undefined) throw new Error(`Graph binding was not found: ${value.$ref}`);
		return resolved;
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, resolveBindings(item as BindingValue, context)]),
	);
}

export function conditionMatches(condition: GraphCondition | undefined, context: GraphBindingContext): boolean {
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
