import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodeNodeLoader } from "../src/code-node.ts";

describe("code nodes", () => {
	it("loads a TypeScript entry and validates input, params, and output", async () => {
		const directory = fileURLToPath(new URL("./fixtures", import.meta.url));
		const loader = new CodeNodeLoader();
		const runtime = { runId: "run", unit: "unit", status: "running" as const, step: 1, visits: {} };
		const result = await loader.run({
			entry: "./code-nodes.ts#uppercase",
			unitDirectory: directory,
			input: { text: "pie" },
			params: { prefix: "mini-" },
			state: {},
			signal: new AbortController().signal,
			runtime,
		});
		expect(result).toEqual({ output: { value: "mini-PIE" }, statePatch: { lastValue: "pie" } });

		await expect(
			loader.run({
				entry: "./code-nodes.ts#uppercase",
				unitDirectory: directory,
				input: { text: 1 },
				params: { prefix: "mini-" },
				state: {},
				signal: new AbortController().signal,
				runtime,
			}),
		).rejects.toThrow("Code node input validation failed");
	});
});
