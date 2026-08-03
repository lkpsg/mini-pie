import { defineCodeNode, Type } from "mini-pie";

export const prepareText = defineCodeNode({
	input: Type.Unknown(),
	output: Type.Object({ text: Type.String() }),
	async run({ input }) {
		const text = typeof input === "string" ? input : (JSON.stringify(input) ?? "");
		const normalized = text.replace(/\s+/g, " ").trim();
		if (normalized.length === 0) throw new Error("Input must contain text");
		return {
			output: { text: normalized },
			statePatch: { sourceCharacters: normalized.length },
		};
	},
});

export const buildResult = defineCodeNode({
	input: Type.Object({
		summary: Type.String(),
		sourceCharacters: Type.Integer({ minimum: 0 }),
	}),
	output: Type.Object({
		summary: Type.String(),
		sourceCharacters: Type.Integer({ minimum: 0 }),
	}),
	async run({ input }) {
		return { output: input };
	},
});
