import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

export class Semaphore {
	private active = 0;
	private readonly waiting: Array<() => void> = [];
	private readonly capacity: number;

	constructor(capacity: number) {
		this.capacity = capacity;
	}

	async run<T>(operation: () => Promise<T>): Promise<T> {
		if (this.active >= this.capacity) await new Promise<void>((resolve) => this.waiting.push(resolve));
		this.active++;
		try {
			return await operation();
		} finally {
			this.active--;
			this.waiting.shift()?.();
		}
	}
}

const delegateSchema = Type.Object({
	agent: Type.String({ description: "Name of an allowed subagent" }),
	task: Type.String({ description: "Self-contained task for the subagent" }),
});

export function createDelegateTool(options: {
	allowedAgents: readonly string[];
	semaphore: Semaphore;
	run: (agent: string, task: string, signal?: AbortSignal) => Promise<string>;
}): AgentTool<typeof delegateSchema, { agent: string }> {
	return {
		name: "delegate",
		label: "delegate",
		description: `Delegate an isolated task to one of these subagents: ${options.allowedAgents.join(", ")}. The subagent shares the workspace but not conversation history.`,
		parameters: delegateSchema,
		async execute(_id, { agent, task }, signal) {
			if (!options.allowedAgents.includes(agent)) throw new Error(`Subagent is not allowed: ${agent}`);
			const output = await options.semaphore.run(async () => {
				if (signal?.aborted) throw new Error("Operation aborted");
				return options.run(agent, task, signal);
			});
			return { content: [{ type: "text", text: output }], details: { agent } };
		},
	};
}
