import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolSet, defineTool } from "../src/tools/index.ts";
import { resolveWorkspacePath } from "../src/workspace.ts";

async function execute(tools: readonly AgentTool[], name: string, parameters: unknown) {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing tool: ${name}`);
	return tool.execute("test-call", parameters as never);
}

const typedTool = defineTool({
	name: "uppercase",
	label: "uppercase",
	description: "Uppercase text",
	parameters: Type.Object({ text: Type.String() }),
	async execute(_id, { text }) {
		return { content: [{ type: "text", text: text.toUpperCase() }], details: {} };
	},
});

describe("built-in tools", () => {
	let workspace: string;

	beforeEach(async () => {
		workspace = await mkdtemp(join(tmpdir(), "mini-pie-test-"));
	});

	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true });
	});

	it("writes, reads, searches, finds, and lists files", async () => {
		const toolSet = createToolSet(["write", "read", "grep", "find", "ls"], workspace);
		try {
			await execute(toolSet.tools, "write", { path: "note.txt", content: "hello\n" });
			const read = await execute(toolSet.tools, "read", { path: "note.txt" });
			expect(read.content[0]).toMatchObject({ type: "text", text: "hello\n" });

			const grep = await execute(toolSet.tools, "grep", { pattern: "hello", path: "." });
			expect(grep.content[0]).toMatchObject({ type: "text", text: "note.txt:1:hello" });

			const find = await execute(toolSet.tools, "find", { pattern: "**/*.txt", path: "." });
			expect(find.content[0]).toMatchObject({ type: "text", text: "note.txt" });

			const list = await execute(toolSet.tools, "ls", { path: "." });
			expect(list.content[0]).toMatchObject({ type: "text" });
			expect((list.content[0] as { text: string }).text).toContain("note.txt");
		} finally {
			await toolSet.dispose();
		}
	});

	it("rejects paths outside the workspace", async () => {
		await expect(resolveWorkspacePath(workspace, "../outside.txt")).rejects.toThrow("outside the workspace");
		await expect(resolveWorkspacePath(workspace, "~/secret.txt")).rejects.toThrow("Special path syntax");
	});

	it("preserves custom tool parameter types", async () => {
		const result = await execute([typedTool], "uppercase", { text: "mini" });
		expect(result.content[0]).toMatchObject({ type: "text", text: "MINI" });
	});
});
