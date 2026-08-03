import { defineCodeNode, Type } from "mini-pie";

export const prepare = defineCodeNode({
	input: Type.Unknown(),
	output: Type.Object({ task: Type.String() }),
	async run({ input }) {
		const task = typeof input === "string" ? input.trim() : (JSON.stringify(input, null, 2) ?? "null");
		return { output: { task } };
	},
});

export const buildPlan = defineCodeNode({
	input: Type.Object({
		task: Type.String(),
		analysis: Type.String(),
		risks: Type.String(),
		tests: Type.String(),
	}),
	output: Type.String(),
	async run({ input }) {
		return {
			output: [
				`Implement: ${input.task}`,
				`Analysis:\n${input.analysis}`,
				`Risks:\n${input.risks}`,
				`Tests:\n${input.tests}`,
			].join("\n\n"),
		};
	},
});

export const classify = defineCodeNode({
	input: Type.String(),
	output: Type.Object({
		status: Type.Union([Type.Literal("completed"), Type.Literal("retry")]),
		text: Type.String(),
	}),
	async run({ input, state }) {
		const retries = typeof state.retries === "number" ? state.retries : 0;
		const shouldRetry = input.includes("RETRY_REQUIRED") && retries < 1;
		const status: "completed" | "retry" = shouldRetry ? "retry" : "completed";
		return {
			output: { status, text: input },
			statePatch: { retries: shouldRetry ? retries + 1 : retries },
		};
	},
});
