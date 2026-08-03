import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GraphNodeRunner, runGraph } from "../src/graph.ts";
import { JsonlGraphRunStore } from "../src/graph-store.ts";
import type { GraphUnitDefinition } from "../src/types.ts";

describe("graph execution", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "mini-pie-graph-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("runs code, parallel agents, joins, conditions, and retries", async () => {
		let activeAgents = 0;
		let maximumActiveAgents = 0;
		let coderAttempts = 0;
		const runner: GraphNodeRunner = {
			async runCode({ input }) {
				return { output: { task: input, proceed: true }, statePatch: { prepared: true } };
			},
			async runAgent(unit, input) {
				activeAgents++;
				maximumActiveAgents = Math.max(maximumActiveAgents, activeAgents);
				try {
					await new Promise((resolve) => setTimeout(resolve, 5));
					if (unit === "coder" && coderAttempts++ === 0) throw new Error("temporary");
					return unit === "coder" ? `implemented:${JSON.stringify(input)}` : `${String(input)}:${unit}`;
				} finally {
					activeAgents--;
				}
			},
		};
		const definition: GraphUnitDefinition = {
			kind: "graph",
			entry: "prepare",
			nodes: {
				prepare: { type: "code", entry: "./nodes.ts#prepare", input: { $ref: "input" } },
				risks: { type: "agent", unit: "explorer", input: { $ref: "results.prepare.output.task" } },
				tests: { type: "agent", unit: "explorer", input: { $ref: "results.prepare.output.task" } },
				implement: {
					type: "agent",
					unit: "coder",
					join: "all",
					retry: 1,
					input: {
						risks: { $ref: "results.risks.output" },
						tests: { $ref: "results.tests.output" },
					},
				},
			},
			edges: [
				{ from: "prepare", to: "risks", when: { path: "results.prepare.output.proceed", equals: true } },
				{ from: "prepare", to: "tests", when: { path: "results.prepare.output.proceed", equals: true } },
				{ from: "risks", to: "implement" },
				{ from: "tests", to: "implement" },
			],
			output: { $ref: "results.implement.output" },
		};

		const result = await runGraph({
			unit: "sample",
			definition,
			unitDirectory: directory,
			input: "feature",
			store: new JsonlGraphRunStore(directory),
			runner,
		});

		expect(result.status).toBe("succeeded");
		expect(result.output).toContain("implemented");
		expect(result.results.implement?.attempts).toBe(2);
		expect(result.state.prepared).toBe(true);
		expect(maximumActiveAgents).toBe(2);
	});

	it("supports guarded cycles using conditional edges", async () => {
		const definition: GraphUnitDefinition = {
			kind: "graph",
			entry: "loop",
			maxVisits: 4,
			nodes: {
				loop: { type: "code", entry: "./nodes.ts#loop" },
			},
			edges: [{ from: "loop", to: "loop", when: { path: "results.loop.output.again", equals: true } }],
			output: { $ref: "results.loop.output" },
		};
		const result = await runGraph({
			unit: "cycle",
			definition,
			unitDirectory: directory,
			input: null,
			store: new JsonlGraphRunStore(directory),
			runner: {
				async runAgent() {
					throw new Error("not used");
				},
				async runCode({ state }) {
					const count = typeof state.count === "number" ? state.count + 1 : 1;
					return { output: { count, again: count < 3 }, statePatch: { count } };
				},
			},
		});

		expect(result.status).toBe("succeeded");
		expect(result.output).toEqual({ count: 3, again: false });
		expect(result.runtime.visits.loop).toBe(3);
	});

	it("records an external cancellation as aborted", async () => {
		const controller = new AbortController();
		const definition: GraphUnitDefinition = {
			kind: "graph",
			nodes: { wait: { type: "code", entry: "./nodes.ts#wait", retry: 2 } },
		};
		const result = await runGraph({
			unit: "cancelled",
			definition,
			unitDirectory: directory,
			input: null,
			store: new JsonlGraphRunStore(directory),
			signal: controller.signal,
			runner: {
				async runAgent() {
					throw new Error("not used");
				},
				async runCode({ signal }) {
					controller.abort();
					if (signal.aborted) throw new Error("cancelled");
					return { output: "unexpected" };
				},
			},
		});

		expect(result.status).toBe("aborted");
		expect(result.results).toEqual({});
	});
});
