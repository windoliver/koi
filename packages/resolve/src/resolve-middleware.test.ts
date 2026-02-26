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
    factory: (): KoiMiddleware => ({ name, priority }),
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
  test("returns empty array for empty configs", async () => {
    const regResult = createRegistry([]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveMiddleware([], regResult.value, MOCK_CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toEqual([]);
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
    expect(result.value).toHaveLength(3);
    expect(result.value[0]?.name).toBe("mw-low");
    expect(result.value[1]?.name).toBe("mw-mid");
    expect(result.value[2]?.name).toBe("mw-high");
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

  test("aggregates errors when some middleware fail", async () => {
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

  test("aggregates errors when all middleware fail", async () => {
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

  test("returns NOT_FOUND for unregistered middleware", async () => {
    const regResult = createRegistry([]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveMiddleware([{ name: "unknown-mw" }], regResult.value, MOCK_CONTEXT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.message).toContain("not found");
  });
});
