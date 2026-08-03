import type { AgentHarnessTool, AgentTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	NodeExecutionEnv,
} from "@earendil-works/pi-agent-core/node";
import type { TSchema } from "@earendil-works/pi-ai";

function bindTool<TParameters extends TSchema, TDetails>(
	tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
	context: ExecutionToolContext,
): AgentTool<TParameters, TDetails> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.constrainedSampling ? { constrainedSampling: tool.constrainedSampling } : {}),
		...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments } : {}),
		...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
		execute: (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate, context),
	};
}

export interface CoreTools {
	tools: AgentTool[];
	dispose: () => Promise<void>;
}

export function createCoreTools(workspace: string): CoreTools {
	const env = new NodeExecutionEnv({ cwd: workspace });
	const context: ExecutionToolContext = { env };
	return {
		tools: [
			bindTool(createReadTool(), context),
			bindTool(createWriteTool(), context),
			bindTool(createEditTool(), context),
			bindTool(createBashTool(), context),
		],
		dispose: () => env.cleanup(),
	};
}
