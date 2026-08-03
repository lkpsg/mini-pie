import { defineCodeNode, Type } from "mini-pie";

export const routeRequest = defineCodeNode({
	input: Type.String(),
	output: Type.Object({
		route: Type.Union([Type.Literal("summary"), Type.Literal("explain")]),
		text: Type.String(),
	}),
	async run({ input }) {
		const separator = input.indexOf(":");
		const route = input.slice(0, separator).trim().toLowerCase();
		const text = input.slice(separator + 1).trim();
		if (route !== "summary" && route !== "explain") {
			throw new Error('Input must use "summary: <text>" or "explain: <text>"');
		}
		if (text.length === 0) {
			throw new Error('Input must use "summary: <text>" or "explain: <text>"');
		}
		const decision = route === "summary" ? ("summary" as const) : ("explain" as const);
		return { output: { route: decision, text } };
	},
});
