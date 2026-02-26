/**
 * Tests for the single-item resolver.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { createRegistry } from "./registry.js";
import { resolveOne } from "./resolve-one.js";
import type { BrickDescriptor, ResolutionContext } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_MANIFEST: AgentManifest = {
  name: "test-agent",
  version: "0.1.0",
  model: { name: "anthropic:claude-sonnet-4-5-20250929" },
};

const MOCK_CONTEXT: ResolutionContext = {
  manifestDir: "/tmp/test",
  manifest: MOCK_MANIFEST,
  env: {},
};

function makeDescriptor(
  name: string,
  opts?: {
    readonly factory?: BrickDescriptor<unknown>["factory"];
    readonly validator?: BrickDescriptor<unknown>["optionsValidator"];
  },
): BrickDescriptor<unknown> {
  return {
    kind: "middleware",
    name,
    optionsValidator:
      opts?.validator ?? ((input: unknown) => ({ ok: true as const, value: input })),
    factory: opts?.factory ?? ((options) => ({ name, options })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveOne", () => {
  test("resolves with valid descriptor", async () => {
    const desc = makeDescriptor("mw-a");
    const regResult = createRegistry([desc]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveOne("middleware", { name: "mw-a" }, regResult.value, MOCK_CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toEqual({ name: "mw-a", options: {} });
  });

  test("passes options to factory", async () => {
    const desc = makeDescriptor("mw-a");
    const regResult = createRegistry([desc]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveOne(
      "middleware",
      { name: "mw-a", options: { key: "value" } },
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toEqual({ name: "mw-a", options: { key: "value" } });
  });

  test("returns NOT_FOUND for missing descriptor", async () => {
    const desc = makeDescriptor("mw-a");
    const regResult = createRegistry([desc]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveOne(
      "middleware",
      { name: "mw-nonexistent" },
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toContain("not found in registry");
    expect(result.error.message).toContain("Available:");
  });

  test("suggests closest name via Levenshtein distance", async () => {
    const regResult = createRegistry([
      makeDescriptor("@koi/middleware-soul"),
      makeDescriptor("@koi/middleware-audit"),
    ]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveOne(
      "middleware",
      { name: "@koi/middleware-sol" }, // typo — close to "soul"
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.message).toContain("Did you mean");
  });

  test("returns VALIDATION when options validator fails", async () => {
    const desc = makeDescriptor("mw-a", {
      validator: () => ({
        ok: false,
        error: {
          code: "VALIDATION",
          message: "requires 'port' field",
          retryable: false,
        },
      }),
    });
    const regResult = createRegistry([desc]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveOne(
      "middleware",
      { name: "mw-a", options: {} },
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("requires 'port' field");
  });

  test("returns INTERNAL when factory throws", async () => {
    const desc = makeDescriptor("mw-a", {
      factory: () => {
        throw new Error("boom");
      },
    });
    const regResult = createRegistry([desc]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveOne("middleware", { name: "mw-a" }, regResult.value, MOCK_CONTEXT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.message).toContain("boom");
    expect(result.error.cause).toBeInstanceOf(Error);
  });

  test("handles async factory", async () => {
    const desc = makeDescriptor("mw-a", {
      factory: async () => ({ name: "async-result" }),
    });
    const regResult = createRegistry([desc]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveOne("middleware", { name: "mw-a" }, regResult.value, MOCK_CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toEqual({ name: "async-result" });
  });

  test("handles async factory rejection", async () => {
    const desc = makeDescriptor("mw-a", {
      factory: async () => {
        throw new Error("async boom");
      },
    });
    const regResult = createRegistry([desc]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveOne("middleware", { name: "mw-a" }, regResult.value, MOCK_CONTEXT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.message).toContain("async boom");
  });
});
