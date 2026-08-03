import { defineCodeNode, Type } from "mini-pie";

export const normalizeInput = defineCodeNode({
	input: Type.Unknown(),
	output: Type.String(),
	async run({ input }) {
		const text = typeof input === "string" ? input : (JSON.stringify(input) ?? "");
		const normalized = text.replace(/\s+/g, " ").trim();
		if (normalized.length === 0) throw new Error("Input must contain text");
		return { output: normalized };
	},
});

export const formatOutput = defineCodeNode({
	input: Type.String(),
	output: Type.Object({
		summary: Type.String(),
		characters: Type.Integer({ minimum: 0 }),
	}),
	async run({ input }) {
		const summary = input.trim();
		return { output: { summary, characters: summary.length } };
	},
});
