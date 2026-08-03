import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlSession } from "../src/session.ts";

describe("JsonlSession", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "mini-pie-session-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("persists and restores messages", async () => {
		const session = new JsonlSession("sample", directory);
		await session.append({ role: "user", content: "hello", timestamp: 1 });
		expect(await session.load()).toEqual([{ role: "user", content: "hello", timestamp: 1 }]);
	});
});
