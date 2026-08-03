import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MiniPieConfig } from "../src/types.ts";
import { graphForUnit, UnitRegistry } from "../src/units.ts";

describe("unit registry", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "mini-pie-units-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("loads unit folders, validates references, and compiles agent hooks to graph nodes", async () => {
		await mkdir(join(directory, "worker"));
		await mkdir(join(directory, "pipeline"));
		await writeFile(
			join(directory, "worker", "unit.yaml"),
			`kind: agent
model: main
systemPrompt: Work carefully.
hooks:
  before:
    - id: prepare
      entry: ./src/hooks.ts#prepare
  after:
    - id: normalize
      entry: ./src/hooks.ts#normalize
`,
			"utf8",
		);
		await writeFile(
			join(directory, "pipeline", "unit.yaml"),
			`kind: graph
nodes:
  answer:
    type: agent
    unit: worker
`,
			"utf8",
		);
		const config: MiniPieConfig = {
			version: 2,
			models: { main: { api: "openai-responses", model: "test" } },
			units: { worker: "./worker", pipeline: "./pipeline" },
		};

		const registry = await UnitRegistry.load(config, directory);
		expect(registry.list("agent").map((unit) => unit.name)).toEqual(["worker"]);
		const graph = graphForUnit(registry.get("worker"));
		expect(Object.keys(graph.nodes)).toEqual(["before_prepare", "agent", "after_normalize"]);
		expect(graph.edges).toEqual([
			{ from: "before_prepare", to: "agent" },
			{ from: "agent", to: "after_normalize" },
		]);
		expect(graph.output).toEqual({ $ref: "results.after_normalize.output" });
	});
});
