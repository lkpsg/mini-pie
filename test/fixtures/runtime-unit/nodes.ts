import { defineCodeNode, Type } from "../../../src/index.ts";

export const uppercase = defineCodeNode({
	input: Type.Object({ text: Type.String() }),
	output: Type.String(),
	params: Type.Object({ prefix: Type.String() }),
	async run({ input, params }) {
		return { output: `${params.prefix}${input.text.toUpperCase()}` };
	},
});
