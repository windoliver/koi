/**
 * Tests for the middleware section resolver.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest, KoiMiddleware } from "@koi/core";
import { createRegistry } from "./registry.js";
import { resolveMiddleware } from "./resolve-middleware.js";
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

function makeMwDescriptor(name: string, priority: number): BrickDescriptor<KoiMiddleware> {
  return {
    kind: "middleware",
    name,
    optionsValidator: (input: unknown) => ({ ok: true, value: input }),
    factory: (): KoiMiddleware => ({ name, describeCapabilities: () => undefined, priority }),
  };
}

function makeFailingDescriptor(name: string): BrickDescriptor<KoiMiddleware> {
  return {
    kind: "middleware",
    name,
    optionsValidator: (input: unknown) => ({ ok: true, value: input }),
    factory: () => {
      throw new Error(`Factory error for ${name}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveMiddleware", () => {
  test("returns empty middleware and warnings for empty configs", async () => {
    const regResult = createRegistry([]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveMiddleware([], regResult.value, MOCK_CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.middleware).toEqual([]);
    expect(result.value.warnings).toEqual([]);
  });

  test("resolves multiple middleware sorted by priority", async () => {
    const regResult = createRegistry([
      makeMwDescriptor("mw-high", 900),
      makeMwDescriptor("mw-low", 100),
      makeMwDescriptor("mw-mid", 500),
    ]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveMiddleware(
      [{ name: "mw-high" }, { name: "mw-low" }, { name: "mw-mid" }],
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.middleware).toHaveLength(3);
    expect(result.value.middleware[0]?.name).toBe("mw-low");
    expect(result.value.middleware[1]?.name).toBe("mw-mid");
    expect(result.value.middleware[2]?.name).toBe("mw-high");
    expect(result.value.warnings).toEqual([]);
  });

  test("returns VALIDATION error for duplicate names", async () => {
    const regResult = createRegistry([makeMwDescriptor("mw-a", 500)]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveMiddleware(
      [{ name: "mw-a" }, { name: "mw-a" }],
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("Duplicate middleware name");
  });

  test("aggregates errors when some required middleware fail", async () => {
    const regResult = createRegistry([
      makeMwDescriptor("mw-good", 500),
      makeFailingDescriptor("mw-bad"),
    ]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveMiddleware(
      [{ name: "mw-good" }, { name: "mw-bad" }],
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("mw-bad");
  });

  test("aggregates errors when all required middleware fail", async () => {
    const regResult = createRegistry([
      makeFailingDescriptor("mw-a"),
      makeFailingDescriptor("mw-b"),
    ]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveMiddleware(
      [{ name: "mw-a" }, { name: "mw-b" }],
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.message).toContain("2 error(s)");
    expect(result.error.message).toContain("mw-a");
    expect(result.error.message).toContain("mw-b");
  });

  test("returns NOT_FOUND for unregistered required middleware", async () => {
    const regResult = createRegistry([]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveMiddleware([{ name: "unknown-mw" }], regResult.value, MOCK_CONTEXT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.message).toContain("not found");
  });

  // ---------------------------------------------------------------------------
  // Graceful degradation (required flag)
  // ---------------------------------------------------------------------------

  test("skips all optional middleware with warnings when all fail", async () => {
    const regResult = createRegistry([
      makeFailingDescriptor("mw-opt-a"),
      makeFailingDescriptor("mw-opt-b"),
    ]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveMiddleware(
      [
        { name: "mw-opt-a", required: false },
        { name: "mw-opt-b", required: false },
      ],
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.middleware).toEqual([]);
    expect(result.value.warnings).toHaveLength(2);
    expect(result.value.warnings[0]).toContain("mw-opt-a");
    expect(result.value.warnings[1]).toContain("mw-opt-b");
  });

  test("returns required middleware and warnings when only optional fails", async () => {
    const regResult = createRegistry([
      makeMwDescriptor("mw-required", 100),
      makeFailingDescriptor("mw-optional"),
    ]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveMiddleware(
      [{ name: "mw-required" }, { name: "mw-optional", required: false }],
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.middleware).toHaveLength(1);
    expect(result.value.middleware[0]?.name).toBe("mw-required");
    expect(result.value.warnings).toHaveLength(1);
    expect(result.value.warnings[0]).toContain("mw-optional");
  });

  test("fails when required middleware fails alongside optional failure", async () => {
    const regResult = createRegistry([
      makeFailingDescriptor("mw-required"),
      makeFailingDescriptor("mw-optional"),
    ]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveMiddleware(
      [{ name: "mw-required" }, { name: "mw-optional", required: false }],
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.message).toContain("mw-required");
  });

  test("returns all middleware with empty warnings when optional succeeds", async () => {
    const regResult = createRegistry([
      makeMwDescriptor("mw-opt-a", 200),
      makeMwDescriptor("mw-opt-b", 400),
    ]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveMiddleware(
      [
        { name: "mw-opt-a", required: false },
        { name: "mw-opt-b", required: false },
      ],
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.middleware).toHaveLength(2);
    expect(result.value.warnings).toEqual([]);
  });

  test("treats missing required field as required (backward compat)", async () => {
    const regResult = createRegistry([makeFailingDescriptor("mw-default")]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveMiddleware([{ name: "mw-default" }], regResult.value, MOCK_CONTEXT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.message).toContain("mw-default");
  });

  test("returns both required and optional middleware when all succeed", async () => {
    const regResult = createRegistry([
      makeMwDescriptor("mw-req", 100),
      makeMwDescriptor("mw-opt", 200),
    ]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveMiddleware(
      [{ name: "mw-req" }, { name: "mw-opt", required: false }],
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.middleware).toHaveLength(2);
    expect(result.value.middleware[0]?.name).toBe("mw-req");
    expect(result.value.middleware[1]?.name).toBe("mw-opt");
    expect(result.value.warnings).toEqual([]);
  });
});
