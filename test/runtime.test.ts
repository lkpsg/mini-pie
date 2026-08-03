import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "../src/runtime.ts";
import type { MiniPieConfig } from "../src/types.ts";

describe("runtime graph integration", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "mini-pie-runtime-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("loads and runs a code-only unit through the public runtime", async () => {
		const repository = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
		const config: MiniPieConfig = {
			version: 2,
			workspace: repository,
			storage: { directory },
			models: { main: { api: "openai-responses", model: "test-model" } },
			units: { uppercase: "./test/fixtures/runtime-unit" },
		};
		const runtime = await createRuntime(config, { baseDir: repository });
		const result = await runtime.runUnit("uppercase", "pie", { runId: "runtime-run" });

		expect(result.status).toBe("succeeded");
		expect(result.output).toBe("mini-PIE");
		expect(runtime.listUnits("graph").map((unit) => unit.name)).toEqual(["uppercase"]);
	});
});
