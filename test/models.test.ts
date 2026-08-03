import { describe, expect, it } from "vitest";
import { createModelRegistry } from "../src/models.ts";

describe("model registry", () => {
	it("groups several model aliases under one provider", () => {
		const registry = createModelRegistry({
			primary: { api: "openai-responses", provider: "openai", model: "model-a" },
			secondary: { api: "openai-responses", provider: "openai", model: "model-b" },
		});

		expect(registry.byName.get("primary")?.id).toBe("model-a");
		expect(registry.models.getProvider("openai")?.getModels()).toHaveLength(2);
	});

	it("rejects conflicting credentials within one provider", () => {
		expect(() =>
			createModelRegistry({
				primary: { api: "openai-responses", provider: "openai", model: "model-a", apiKeyEnv: "KEY_A" },
				secondary: { api: "openai-responses", provider: "openai", model: "model-b", apiKeyEnv: "KEY_B" },
			}),
		).toThrow("must use the same apiKeyEnv");
	});
});
