import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "../src/types.ts";
import { runWorkflow } from "../src/workflow.ts";

describe("workflow", () => {
	it("runs sequential, parallel, conditional, and retried steps", async () => {
		const prompts: string[] = [];
		let flakyAttempts = 0;
		const definition: WorkflowDefinition = {
			steps: [
				{ id: "inspect", agent: "explorer", prompt: "inspect {{input}}" },
				{
					parallel: [
						{ id: "risks", agent: "explorer", prompt: "risks {{steps.inspect.output}}" },
						{ id: "tests", agent: "explorer", prompt: "tests {{steps.inspect.output}}" },
					],
				},
				{
					id: "implement",
					agent: "coder",
					prompt: "implement {{steps.risks.output}} and {{steps.tests.output}}",
					when: { path: "steps.inspect.output", notEquals: "" },
					retry: 1,
				},
			],
		};

		const result = await runWorkflow({
			name: "sample",
			definition,
			input: "feature",
			baseDir: process.cwd(),
			runner: {
				runAgent: async (agent, prompt) => {
					prompts.push(`${agent}:${prompt}`);
					if (agent === "coder" && flakyAttempts++ === 0) throw new Error("temporary");
					return `${agent}-result`;
				},
			},
		});

		expect(result.output).toBe("coder-result");
		expect(result.steps.implement?.attempts).toBe(2);
		expect(prompts).toContain("explorer:risks explorer-result");
		expect(prompts).toContain("explorer:tests explorer-result");
	});
});
