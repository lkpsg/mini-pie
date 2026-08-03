import { defineCodeNode, Type } from "../../src/index.ts";

export const uppercase = defineCodeNode({
	input: Type.Object({ text: Type.String() }),
	output: Type.Object({ value: Type.String() }),
	params: Type.Object({ prefix: Type.String() }),
	async run({ input, params }) {
		return {
			output: { value: `${params.prefix}${input.text.toUpperCase()}` },
			statePatch: { lastValue: input.text },
		};
	},
});
