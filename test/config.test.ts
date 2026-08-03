import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfigText, parseUnitText } from "../src/config.ts";

describe("configuration", () => {
	it("parses v2 unit registrations, storage, models, and environment placeholders", () => {
		const config = parseConfigText(
			`version: 2
workspace: .
storage:
  directory: .state/runs
models:
  main:
    api: openai-responses
    model: test-model
    provider: openai
    headers:
      x-project: \${PROJECT_NAME}
units:
  worker: ./units/worker
  pipeline:
    path: ./units/pipeline
`,
			{ PROJECT_NAME: "mini-pie" },
		);

		expect(config.models.main?.headers?.["x-project"]).toBe("mini-pie");
		expect(config.storage?.directory).toBe(".state/runs");
		expect(config.units.pipeline).toEqual({ path: "./units/pipeline" });
	});

	it("parses agent hooks and graph nodes", () => {
		const models = { main: {} };
		const agent = parseUnitText(
			`kind: agent
model: main
systemPrompt: Work carefully.
tools: [read]
hooks:
  before:
    - id: prepare
      entry: ./src/hooks.ts#prepare
  after:
    - id: normalize
      entry: ./src/hooks.ts#normalize
review:
  after: true
`,
			models,
		);
		expect(agent.kind).toBe("agent");
		if (agent.kind !== "agent") throw new Error("Expected agent unit");
		expect(agent.hooks?.before?.[0]?.id).toBe("prepare");

		const graph = parseUnitText(
			`kind: graph
entry: prepare
nodes:
  prepare:
    type: code
    entry: ./src/nodes.ts#prepare
  answer:
    type: agent
    unit: worker
    input:
      $ref: results.prepare.output
edges:
  - from: prepare
    to: answer
output:
  $ref: results.answer.output
`,
			models,
		);
		expect(graph.kind).toBe("graph");
		if (graph.kind !== "graph") throw new Error("Expected graph unit");
		expect(graph.nodes.answer).toMatchObject({ type: "agent", unit: "worker" });
	});

	it("rejects v1 configuration and invalid graph references", () => {
		expect(() =>
			parseConfigText(`version: 1
models: {}
units: {}
`),
		).toThrow("expected 2");

		expect(() =>
			parseUnitText(
				`kind: graph
nodes:
  start:
    type: code
    entry: ./node.ts#run
edges:
  - from: start
    to: missing
`,
				{},
			),
		).toThrow('unknown node "missing"');
	});

	it("loads a .env file next to the configuration without overriding the process environment", async () => {
		const directory = await mkdtemp(join(tmpdir(), "mini-pie-env-"));
		const variable = "MINI_PIE_TEST_BASE_URL";
		const existingVariable = "MINI_PIE_TEST_EXISTING";
		const previous = process.env[variable];
		const previousExisting = process.env[existingVariable];
		delete process.env[variable];
		process.env[existingVariable] = "from-process";
		try {
			await writeFile(
				join(directory, ".env"),
				`${variable}=https://gateway.example/v1\n${existingVariable}=from-file\n`,
				"utf8",
			);
			await writeFile(
				join(directory, "mini-pie.yaml"),
				`version: 2
models:
  main:
    api: openai-responses
    model: test-model
    baseUrl: \${${variable}}
    headers:
      x-source: \${${existingVariable}}
units:
  worker: ./worker
`,
				"utf8",
			);

			const loaded = await loadConfig(join(directory, "mini-pie.yaml"));
			expect(loaded.config.models.main?.baseUrl).toBe("https://gateway.example/v1");
			expect(loaded.config.models.main?.headers?.["x-source"]).toBe("from-process");
			expect(process.env[variable]).toBe("https://gateway.example/v1");
		} finally {
			if (previous === undefined) delete process.env[variable];
			else process.env[variable] = previous;
			if (previousExisting === undefined) delete process.env[existingVariable];
			else process.env[existingVariable] = previousExisting;
			await rm(directory, { recursive: true, force: true });
		}
	});
});
