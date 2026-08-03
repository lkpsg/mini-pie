import { defineCodeNode, Type } from "mini-pie";

export const prepareInput = defineCodeNode({
	input: Type.Unknown(),
	output: Type.String(),
	async run({ input }) {
		const text = typeof input === "string" ? input : (JSON.stringify(input, null, 2) ?? "null");
		return { output: text.trim() };
	},
});

export const parseOutput = defineCodeNode({
	input: Type.String(),
	output: Type.Object({
		text: Type.String(),
		status: Type.Union([Type.Literal("completed"), Type.Literal("needs_review")]),
	}),
	async run({ input }) {
		const status: "completed" | "needs_review" = input.includes("NEEDS_REVIEW") ? "needs_review" : "completed";
		return { output: { text: input, status }, statePatch: { status } };
	},
});
