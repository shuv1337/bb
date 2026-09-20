import { describe, expect, it } from "vitest";
import {
  parseWireModelId,
  toAvailableModels,
  toOpenCodeModel,
  toWireModelId,
} from "./models.js";

describe("models", () => {
  it("keeps extra variants off the closed ladder and omits routeProviderId", () => {
    const model = toOpenCodeModel({
      providerID: "openrouter",
      id: "some-model",
      name: "Some",
      variants: [{ id: "low" }, { id: "thinking" }, { id: "minimal" }],
      isDefault: true,
      defaultVariant: "low",
    });
    expect(model.variants.map((variant) => variant.id)).toEqual([
      "low",
      "thinking",
      "minimal",
    ]);
    const [available] = toAvailableModels({
      models: [model],
      defaultModel: { providerID: "openrouter", id: "some-model", variant: "low" },
    });
    expect(available?.supportedReasoningEfforts.map((e) => e.reasoningEffort)).toEqual(
      ["low"],
    );
    expect(available?.defaultReasoningEffort).toBe("low");
    expect(available?.routeProviderId).toBeUndefined();
    expect(available?.description).toContain("thinking");
  });

  it("does not invent a none variant for empty google variants", () => {
    const model = toOpenCodeModel({
      providerID: "google",
      id: "gemini-3.7-flash-high",
      name: "Gemini 3.7 Flash (High)",
      variants: [],
      limit: { context: 1048576, output: 65536 },
    });
    const [available] = toAvailableModels({
      models: [model],
      defaultModel: { providerID: "google", id: "gemini-3.7-flash-high" },
    });
    expect(available?.id).toBe("google/gemini-3.7-flash-high");
    expect(available?.isDefault).toBe(true);
    expect(available?.supportedReasoningEfforts).toEqual([]);
    expect(available?.defaultReasoningEffort).toBe("none");
    expect(model.limit?.context).toBe(1048576);
  });

  it("does not mark the first model default without a real default", () => {
    const models = toAvailableModels({
      models: [
        toOpenCodeModel({
          providerID: "a",
          id: "one",
          name: "One",
          variants: [{ id: "high" }],
        }),
      ],
    });
    expect(models[0]?.isDefault).toBe(false);
    expect(models[0]?.defaultReasoningEffort).toBe("high");
  });

  it("filters disabled models", () => {
    const models = toAvailableModels({
      models: [
        toOpenCodeModel({
          providerID: "a",
          id: "off",
          name: "Off",
          enabled: false,
        }),
        toOpenCodeModel({
          providerID: "a",
          id: "on",
          name: "On",
          enabled: true,
        }),
      ],
      defaultModel: { providerID: "a", id: "on" },
    });
    expect(models.map((model) => model.id)).toEqual(["a/on"]);
  });

  it("parses wire ids at the first slash", () => {
    expect(toWireModelId({ providerID: "google", id: "m" })).toBe("google/m");
    expect(parseWireModelId("google/gemini-3.7-flash-high")).toEqual({
      providerID: "google",
      id: "gemini-3.7-flash-high",
    });
    expect(parseWireModelId("noslash")).toBeNull();
  });
});
