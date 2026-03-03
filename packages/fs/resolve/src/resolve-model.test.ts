/**
 * Tests for the model section resolver.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest, ModelHandler } from "@koi/core";
import { createRegistry } from "./registry.js";
import { parseModelName, resolveModel } from "./resolve-model.js";
import type { BrickDescriptor, ResolutionContext } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_MANIFEST: AgentManifest = {
  name: "test-agent",
  version: "0.1.0",
  model: { name: "anthropic:claude-sonnet-4-5-20250929" },
};

function makeModelDescriptor(providerName: string, envKey: string): BrickDescriptor<ModelHandler> {
  return {
    kind: "model",
    name: providerName,
    optionsValidator: (input: unknown) => ({ ok: true as const, value: input }),
    factory: (options, context): ModelHandler => {
      const apiKey = context.env[envKey];
      if (!apiKey) {
        throw new Error(`Missing API key: ${envKey}`);
      }
      const model = typeof options.model === "string" ? options.model : "";
      return async () => ({
        content: `[${providerName}:${model}] response`,
        model,
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// parseModelName tests
// ---------------------------------------------------------------------------

describe("parseModelName", () => {
  test("parses valid provider:model format", () => {
    const result = parseModelName("anthropic:claude-sonnet-4-5-20250929");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.provider).toBe("anthropic");
    expect(result.value.model).toBe("claude-sonnet-4-5-20250929");
  });

  test("handles model with colons", () => {
    const result = parseModelName("openrouter:meta/llama-3:70b");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.provider).toBe("openrouter");
    expect(result.value.model).toBe("meta/llama-3:70b");
  });

  test("returns VALIDATION for missing colon", () => {
    const result = parseModelName("just-a-model-name");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("provider:model");
  });

  test("returns VALIDATION for empty provider", () => {
    const result = parseModelName(":claude-sonnet");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("non-empty");
  });

  test("returns VALIDATION for empty model", () => {
    const result = parseModelName("anthropic:");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("non-empty");
  });
});

// ---------------------------------------------------------------------------
// resolveModel tests
// ---------------------------------------------------------------------------

describe("resolveModel", () => {
  test("resolves valid model provider", async () => {
    const regResult = createRegistry([makeModelDescriptor("anthropic", "ANTHROPIC_API_KEY")]);
    if (!regResult.ok) throw new Error("Registry failed");

    const context: ResolutionContext = {
      manifestDir: "/tmp/test",
      manifest: MOCK_MANIFEST,
      env: { ANTHROPIC_API_KEY: "sk-test-key" },
    };

    const result = await resolveModel(
      { name: "anthropic:claude-sonnet-4-5-20250929" },
      regResult.value,
      context,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(typeof result.value).toBe("function");
  });

  test("returned handler produces responses", async () => {
    const regResult = createRegistry([makeModelDescriptor("anthropic", "ANTHROPIC_API_KEY")]);
    if (!regResult.ok) throw new Error("Registry failed");

    const context: ResolutionContext = {
      manifestDir: "/tmp/test",
      manifest: MOCK_MANIFEST,
      env: { ANTHROPIC_API_KEY: "sk-test-key" },
    };

    const result = await resolveModel({ name: "anthropic:my-model" }, regResult.value, context);
    if (!result.ok) throw new Error("Expected ok");

    const response = await result.value({
      messages: [
        { senderId: "user-1", content: [{ kind: "text", text: "hello" }], timestamp: Date.now() },
      ],
    });
    expect(response.content).toContain("anthropic:my-model");
  });

  test("returns NOT_FOUND for unknown provider", async () => {
    const regResult = createRegistry([makeModelDescriptor("anthropic", "ANTHROPIC_API_KEY")]);
    if (!regResult.ok) throw new Error("Registry failed");

    const context: ResolutionContext = {
      manifestDir: "/tmp/test",
      manifest: MOCK_MANIFEST,
      env: {},
    };

    const result = await resolveModel(
      { name: "unknown-provider:some-model" },
      regResult.value,
      context,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toContain("unknown-provider");
  });

  test("suggests closest provider name", async () => {
    const regResult = createRegistry([
      makeModelDescriptor("anthropic", "ANTHROPIC_API_KEY"),
      makeModelDescriptor("openai", "OPENAI_API_KEY"),
    ]);
    if (!regResult.ok) throw new Error("Registry failed");

    const context: ResolutionContext = {
      manifestDir: "/tmp/test",
      manifest: MOCK_MANIFEST,
      env: {},
    };

    const result = await resolveModel(
      { name: "anthrpic:claude" }, // typo
      regResult.value,
      context,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.message).toContain("Did you mean");
  });

  test("returns INTERNAL when factory throws (missing API key)", async () => {
    const regResult = createRegistry([makeModelDescriptor("anthropic", "ANTHROPIC_API_KEY")]);
    if (!regResult.ok) throw new Error("Registry failed");

    const context: ResolutionContext = {
      manifestDir: "/tmp/test",
      manifest: MOCK_MANIFEST,
      env: {}, // No API key
    };

    const result = await resolveModel(
      { name: "anthropic:claude-sonnet" },
      regResult.value,
      context,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.message).toContain("ANTHROPIC_API_KEY");
  });

  test("returns VALIDATION for malformed model name", async () => {
    const regResult = createRegistry([]);
    if (!regResult.ok) throw new Error("Registry failed");

    // Context is unused — parseModelName fails before reaching factory
    const context: ResolutionContext = {
      manifestDir: "/tmp/test",
      manifest: MOCK_MANIFEST,
      env: {},
    };

    const result = await resolveModel({ name: "no-colon-model" }, regResult.value, context);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
  });
});
