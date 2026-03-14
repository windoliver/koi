import { describe, expect, test } from "bun:test";
import { extractProvider, parseModelId } from "./model-id.js";

describe("parseModelId", () => {
  test("parses provider:model format", () => {
    expect(parseModelId("anthropic:claude-sonnet-4-5-20250929")).toEqual({
      provider: "anthropic",
      modelName: "claude-sonnet-4-5-20250929",
    });
  });

  test("parses openai provider", () => {
    expect(parseModelId("openai:gpt-4o")).toEqual({
      provider: "openai",
      modelName: "gpt-4o",
    });
  });

  test("returns empty provider when no colon present", () => {
    expect(parseModelId("claude-sonnet-4-5-20250929")).toEqual({
      provider: "",
      modelName: "claude-sonnet-4-5-20250929",
    });
  });

  test("handles empty string", () => {
    expect(parseModelId("")).toEqual({
      provider: "",
      modelName: "",
    });
  });

  test("handles multiple colons — only first is delimiter", () => {
    expect(parseModelId("openai:gpt-4:2024-05-13")).toEqual({
      provider: "openai",
      modelName: "gpt-4:2024-05-13",
    });
  });

  test("handles colon at start — empty provider", () => {
    expect(parseModelId(":model-name")).toEqual({
      provider: "",
      modelName: "model-name",
    });
  });

  test("handles colon at end — empty model name", () => {
    expect(parseModelId("anthropic:")).toEqual({
      provider: "anthropic",
      modelName: "",
    });
  });

  test("handles provider-only with colon", () => {
    expect(parseModelId("openai:")).toEqual({
      provider: "openai",
      modelName: "",
    });
  });
});

describe("extractProvider", () => {
  test("extracts anthropic provider", () => {
    expect(extractProvider("anthropic:claude-sonnet-4-5-20250929")).toBe("anthropic");
  });

  test("extracts openai provider", () => {
    expect(extractProvider("openai:gpt-4o")).toBe("openai");
  });

  test("returns empty string when no colon", () => {
    expect(extractProvider("gpt-4o")).toBe("");
  });

  test("returns empty string for empty input", () => {
    expect(extractProvider("")).toBe("");
  });

  test("handles multiple colons — returns first segment", () => {
    expect(extractProvider("openai:gpt-4:2024")).toBe("openai");
  });
});
