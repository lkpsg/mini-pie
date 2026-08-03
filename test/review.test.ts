import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphExecutor, type GraphNodeRunner } from "../src/graph.ts";
import { JsonlGraphRunStore } from "../src/graph-store.ts";
import type { GraphUnitDefinition } from "../src/types.ts";

describe("graph review checkpoints", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "mini-pie-review-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("persists before and after review points and resumes with edited output", async () => {
		let runs = 0;
		const definition: GraphUnitDefinition = {
			kind: "graph",
			entry: "transform",
			nodes: {
				transform: {
					type: "code",
					entry: "./nodes.ts#transform",
					review: { before: true, after: true, message: "Inspect the transformation" },
				},
			},
			output: { $ref: "results.transform.output" },
		};
		const runner: GraphNodeRunner = {
			async runAgent() {
				throw new Error("not used");
			},
			async runCode({ input }) {
				runs++;
				return { output: { original: input }, statePatch: { transformed: true } };
			},
		};
		const store = new JsonlGraphRunStore(directory);
		const executor = new GraphExecutor({ unit: "reviewed", definition, unitDirectory: directory, store, runner });

		const before = await executor.start({ input: "data", runId: "review-run" });
		expect(before.status).toBe("waiting_review");
		expect(before.review).toMatchObject({ node: "transform", phase: "before", input: "data" });
		expect(runs).toBe(0);

		const after = await new GraphExecutor({
			unit: "reviewed",
			definition,
			unitDirectory: directory,
			store,
			runner,
		}).resume(await store.load("review-run"), { action: "approve" });
		expect(after.status).toBe("waiting_review");
		expect(after.review).toMatchObject({ node: "transform", phase: "after" });
		expect(runs).toBe(1);

		const completed = await new GraphExecutor({
			unit: "reviewed",
			definition,
			unitDirectory: directory,
			store,
			runner,
		}).resume(await store.load("review-run"), { action: "edit", value: { accepted: true } });
		expect(completed.status).toBe("succeeded");
		expect(completed.output).toEqual({ accepted: true });
		expect(completed.state.transformed).toBe(true);
	});

	it("can abort a persisted checkpoint", async () => {
		const definition: GraphUnitDefinition = {
			kind: "graph",
			nodes: { stop: { type: "code", entry: "./nodes.ts#stop", review: { before: true } } },
		};
		const store = new JsonlGraphRunStore(directory);
		const runner: GraphNodeRunner = {
			async runAgent() {
				throw new Error("not used");
			},
			async runCode() {
				return { output: "unexpected" };
			},
		};
		const executor = new GraphExecutor({ unit: "abortable", definition, unitDirectory: directory, store, runner });
		await executor.start({ input: null, runId: "abort-run" });
		const result = await executor.resume(await store.load("abort-run"), { action: "abort" });
		expect(result.status).toBe("aborted");
		expect(result.results).toEqual({});
	});
});
