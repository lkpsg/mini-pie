import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { MiniPieAgent } from "../src/agent.ts";

describe("MiniPieAgent", () => {
	it("runs and streams using Pi state and transport primitives", async () => {
		const faux = fauxProvider({ provider: "faux-test", tokensPerSecond: 0 });
		faux.setResponses([fauxAssistantMessage("done")]);
		const models = createModels();
		models.setProvider(faux.provider);
		const agent = await MiniPieAgent.create({
			name: "worker",
			definition: {
				model: "faux",
				systemPrompt: "System",
				userPrompt: "Task: {{input}}",
				compaction: { enabled: false },
			},
			systemPrompt: "System",
			userPrompt: "Task: {{input}}",
			workspace: process.cwd(),
			models,
			model: faux.getModel(),
			tools: [],
			disposeTools: async () => {},
		});

		try {
			const events = [];
			for await (const event of agent.stream("work")) events.push(event.type);
			expect(events[0]).toBe("start");
			expect(events).toContain("text_delta");
			expect(events.at(-1)).toBe("end");
			expect(agent.messages[0]).toMatchObject({ role: "user" });
			const firstMessage = agent.messages[0];
			if (firstMessage?.role !== "user") throw new Error("Expected user message");
			expect(JSON.stringify(firstMessage.content)).toContain("Task: work");
		} finally {
			await agent.close();
		}
	});
});
