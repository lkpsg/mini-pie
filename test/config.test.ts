import { describe, expect, it } from "vitest";
import { parseConfigText } from "../src/config.ts";

describe("configuration", () => {
	it("parses agents, models, workflows, and environment placeholders", () => {
		const config = parseConfigText(
			`version: 1
workspace: .
models:
  main:
    api: openai-responses
    model: test-model
    provider: openai
    headers:
      x-project: \${PROJECT_NAME}
agents:
  worker:
    model: main
    systemPrompt: Work carefully.
    tools: [read]
  parent:
    model: main
    systemPrompt:
      file: ./parent.md
    subagents: [worker]
workflows:
  sample:
    steps:
      - id: inspect
        agent: worker
        prompt: Inspect {{input}}
`,
			{ PROJECT_NAME: "mini-pie" },
		);

		expect(config.models.main?.headers?.["x-project"]).toBe("mini-pie");
		expect(config.agents.parent?.subagents).toEqual(["worker"]);
		expect(config.workflows?.sample?.steps).toHaveLength(1);
	});

	it("rejects unknown subagents", () => {
		expect(() =>
			parseConfigText(`version: 1
models:
  main:
    api: openai-responses
    model: test-model
agents:
  parent:
    model: main
    systemPrompt: Parent
    subagents: [missing]
`),
		).toThrow('unknown agent "missing"');
	});
});
