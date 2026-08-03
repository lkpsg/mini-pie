import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import type { BuiltinToolName } from "../types.ts";
import { BUILTIN_TOOL_NAMES } from "../types.ts";
import { createCoreTools } from "./core.ts";
import { createMiscTools } from "./misc.ts";
import { createSearchTools } from "./search.ts";

export interface ToolSet {
	tools: AgentTool[];
	dispose: () => Promise<void>;
}

export function isBuiltinToolName(name: string): name is BuiltinToolName {
	return (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}

export function createToolSet(names: string[], workspace: string, customTools: readonly AgentTool[] = []): ToolSet {
	const core = createCoreTools(workspace);
	const registry = new Map<string, AgentTool>();
	for (const tool of [...core.tools, ...createSearchTools(workspace), ...createMiscTools(workspace), ...customTools]) {
		if (registry.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
		registry.set(tool.name, tool);
	}
	const tools = names.map((name) => {
		const tool = registry.get(name);
		if (!tool) throw new Error(`Unknown tool: ${name}`);
		return tool;
	});
	return { tools, dispose: core.dispose };
}

export function defineTool<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
): AgentTool<TParameters, TDetails> {
	return tool;
}

export { createCoreTools } from "./core.ts";
export { createMiscTools } from "./misc.ts";
export { createSearchTools } from "./search.ts";
