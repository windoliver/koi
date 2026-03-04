import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import type { ResolutionContext } from "@koi/resolve";
import { descriptor } from "./descriptor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(env: Readonly<Record<string, string>> = {}): ResolutionContext {
  return {
    manifestDir: "/tmp",
    manifest: {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "anthropic:claude-sonnet-4-5" },
    } as AgentManifest,
    env,
  };
}

function makeValidOptions(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    strategy: "cascade",
    targets: ["anthropic:claude-haiku-4-5", "anthropic:claude-sonnet-4-5"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Descriptor metadata
// ---------------------------------------------------------------------------

describe("descriptor", () => {
  test("has correct metadata", () => {
    expect(descriptor.kind).toBe("middleware");
    expect(descriptor.name).toBe("@koi/model-router");
    expect(descriptor.aliases).toContain("model-router");
  });
});

// ---------------------------------------------------------------------------
// optionsValidator
// ---------------------------------------------------------------------------

describe("optionsValidator", () => {
  test("accepts valid cascade config", () => {
    const result = descriptor.optionsValidator(makeValidOptions());
    expect(result.ok).toBe(true);
  });

  test("accepts valid fallback config", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ strategy: "fallback" }));
    expect(result.ok).toBe(true);
  });

  test("accepts valid round-robin config", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ strategy: "round-robin" }));
    expect(result.ok).toBe(true);
  });

  test("accepts valid weighted config", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ strategy: "weighted" }));
    expect(result.ok).toBe(true);
  });

  test("accepts optional confidenceThreshold", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ confidenceThreshold: 0.8 }));
    expect(result.ok).toBe(true);
  });

  test("accepts confidenceThreshold at boundary 0", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ confidenceThreshold: 0 }));
    expect(result.ok).toBe(true);
  });

  test("accepts confidenceThreshold at boundary 1", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ confidenceThreshold: 1 }));
    expect(result.ok).toBe(true);
  });

  test("accepts optional maxEscalations", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ maxEscalations: 2 }));
    expect(result.ok).toBe(true);
  });

  test("accepts optional budgetLimitTokens", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ budgetLimitTokens: 10000 }));
    expect(result.ok).toBe(true);
  });

  test("rejects non-object input", () => {
    const result = descriptor.optionsValidator("invalid");
    expect(result.ok).toBe(false);
  });

  test("rejects null input", () => {
    const result = descriptor.optionsValidator(null);
    expect(result.ok).toBe(false);
  });

  test("rejects missing strategy", () => {
    const result = descriptor.optionsValidator({
      targets: ["anthropic:claude-haiku-4-5"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("strategy");
    }
  });

  test("rejects invalid strategy", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ strategy: "random" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("strategy");
    }
  });

  test("rejects missing targets", () => {
    const result = descriptor.optionsValidator({ strategy: "cascade" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("targets");
    }
  });

  test("rejects empty targets array", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ targets: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("targets");
    }
  });

  test("rejects target without colon separator", () => {
    const result = descriptor.optionsValidator(
      makeValidOptions({ targets: ["anthropic-claude-haiku"] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("provider:model");
    }
  });

  test("rejects target with empty provider", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ targets: [":claude-haiku"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("non-empty");
    }
  });

  test("rejects target with empty model", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ targets: ["anthropic:"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("non-empty");
    }
  });

  test("rejects non-string targets", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ targets: [42] }));
    expect(result.ok).toBe(false);
  });

  test("rejects confidenceThreshold out of range", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ confidenceThreshold: 1.5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("confidenceThreshold");
    }
  });

  test("rejects negative confidenceThreshold", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ confidenceThreshold: -0.1 }));
    expect(result.ok).toBe(false);
  });

  test("rejects negative maxEscalations", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ maxEscalations: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxEscalations");
    }
  });

  test("rejects negative budgetLimitTokens", () => {
    const result = descriptor.optionsValidator(makeValidOptions({ budgetLimitTokens: -100 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("budgetLimitTokens");
    }
  });
});

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

describe("factory", () => {
  test("throws when API key is missing", () => {
    const opts = makeValidOptions();
    const context = makeContext({}); // no API keys

    expect(() => descriptor.factory(opts, context)).toThrow("ANTHROPIC_API_KEY");
  });

  test("throws for unknown provider", () => {
    const opts = makeValidOptions({
      targets: ["custom-llm:my-model"],
    });
    const context = makeContext({ ANTHROPIC_API_KEY: "sk-test" });

    expect(() => descriptor.factory(opts, context)).toThrow("unknown provider");
  });

  test("creates middleware with cascade strategy", () => {
    const opts = makeValidOptions();
    const context = makeContext({ ANTHROPIC_API_KEY: "sk-test" });

    const mw = descriptor.factory(opts, context);
    expect(mw).toBeDefined();
    expect(mw).toHaveProperty("name", "model-router");
    expect(mw).toHaveProperty("priority", 900);
    expect(mw).toHaveProperty("wrapModelCall");
  });

  test("creates middleware with fallback strategy", () => {
    const opts = makeValidOptions({ strategy: "fallback" });
    const context = makeContext({ ANTHROPIC_API_KEY: "sk-test" });

    const mw = descriptor.factory(opts, context);
    expect(mw).toHaveProperty("name", "model-router");
  });

  test("creates middleware with multiple providers", () => {
    const opts = makeValidOptions({
      strategy: "fallback",
      targets: ["anthropic:claude-sonnet-4-5", "openai:gpt-4o"],
    });
    const context = makeContext({
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENAI_API_KEY: "sk-oai-test",
    });

    const mw = descriptor.factory(opts, context);
    expect(mw).toHaveProperty("name", "model-router");
  });

  test("reuses adapter for same provider across targets", () => {
    // Both targets use "anthropic" — should only need one API key
    const opts = makeValidOptions({
      strategy: "cascade",
      targets: ["anthropic:claude-haiku-4-5", "anthropic:claude-sonnet-4-5"],
    });
    const context = makeContext({ ANTHROPIC_API_KEY: "sk-test" });

    // Should not throw — one adapter handles both models
    const mw = descriptor.factory(opts, context);
    expect(mw).toHaveProperty("name", "model-router");
  });

  test("throws when second provider API key is missing", () => {
    const opts = makeValidOptions({
      strategy: "fallback",
      targets: ["anthropic:claude-sonnet-4-5", "openai:gpt-4o"],
    });
    // Only anthropic key, missing openai
    const context = makeContext({ ANTHROPIC_API_KEY: "sk-test" });

    expect(() => descriptor.factory(opts, context)).toThrow("OPENAI_API_KEY");
  });

  test("applies custom confidenceThreshold to cascade config", () => {
    const opts = makeValidOptions({ confidenceThreshold: 0.9 });
    const context = makeContext({ ANTHROPIC_API_KEY: "sk-test" });

    // Should not throw — valid config with custom threshold
    const mw = descriptor.factory(opts, context);
    expect(mw).toHaveProperty("name", "model-router");
  });

  test("thrown error chains cause with KoiError", () => {
    const opts = makeValidOptions({
      targets: ["custom-llm:my-model"],
    });
    const context = makeContext({});

    try {
      descriptor.factory(opts, context);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      const err = e as Error;
      expect(err.cause).toBeDefined();
      expect(err.cause).toHaveProperty("code");
    }
  });
});
