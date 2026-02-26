/**
 * Tests for the top-level manifest resolver.
 */

import { describe, expect, test } from "bun:test";
import type { KoiMiddleware, ModelHandler } from "@koi/core";
import { createRegistry } from "./registry.js";
import { resolveManifest } from "./resolve-manifest.js";
import type { BrickDescriptor, ResolutionContext } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFullContext(envOverrides?: Record<string, string>): ResolutionContext {
  return {
    manifestDir: "/tmp/test",
    manifest: {
      name: "test-agent",
      version: "0.1.0",
      model: { name: "mock:test-model" },
    },
    env: { MOCK_API_KEY: "sk-test", ...envOverrides },
  };
}

function makeMwDescriptor(name: string, priority: number): BrickDescriptor<KoiMiddleware> {
  return {
    kind: "middleware",
    name,
    optionsValidator: (input: unknown) => ({ ok: true, value: input }),
    factory: (): KoiMiddleware => ({ name, priority }),
  };
}

function makeSoulDescriptor(): BrickDescriptor<KoiMiddleware> {
  return {
    kind: "middleware",
    name: "@koi/middleware-soul",
    aliases: ["soul"],
    optionsValidator: (input: unknown) => ({ ok: true, value: input }),
    factory: (): KoiMiddleware => ({ name: "soul", priority: 500 }),
  };
}

function makePermsDescriptor(): BrickDescriptor<KoiMiddleware> {
  return {
    kind: "middleware",
    name: "@koi/middleware-permissions",
    aliases: ["permissions"],
    optionsValidator: (input: unknown) => ({ ok: true, value: input }),
    factory: (): KoiMiddleware => ({ name: "permissions", priority: 100 }),
  };
}

function makeModelDescriptor(): BrickDescriptor<ModelHandler> {
  return {
    kind: "model",
    name: "mock",
    optionsValidator: (input: unknown) => ({ ok: true, value: input }),
    factory: (_options, context): ModelHandler => {
      const apiKey = context.env.MOCK_API_KEY;
      if (!apiKey) throw new Error("Missing MOCK_API_KEY");
      return async () => ({
        content: "mock response",
        model: "test-model",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveManifest", () => {
  test("resolves minimal manifest (just model)", async () => {
    const regResult = createRegistry([makeModelDescriptor()]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveManifest(
      { model: { name: "mock:test-model" } },
      regResult.value,
      makeFullContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.middleware).toEqual([]);
    expect(typeof result.value.model).toBe("function");
  });

  test("resolves full manifest with all Phase 1 sections", async () => {
    const regResult = createRegistry([
      makeMwDescriptor("mw-audit", 200),
      makeSoulDescriptor(),
      makePermsDescriptor(),
      makeModelDescriptor(),
    ]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveManifest(
      {
        model: { name: "mock:test-model" },
        middleware: [{ name: "mw-audit" }],
        soul: "SOUL.md",
        user: "USER.md",
        permissions: { allow: ["*"], deny: ["rm:*"] },
      },
      regResult.value,
      makeFullContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    // Should have 3 middleware: permissions(100) + audit(200) + soul(500)
    expect(result.value.middleware).toHaveLength(3);
    expect(result.value.middleware[0]?.name).toBe("permissions");
    expect(result.value.middleware[1]?.name).toBe("mw-audit");
    expect(result.value.middleware[2]?.name).toBe("soul");

    expect(typeof result.value.model).toBe("function");
  });

  test("merges middleware + soul + permissions sorted by priority", async () => {
    const regResult = createRegistry([
      makeMwDescriptor("mw-high", 900),
      makeSoulDescriptor(), // priority 500
      makePermsDescriptor(), // priority 100
      makeModelDescriptor(),
    ]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveManifest(
      {
        model: { name: "mock:test-model" },
        middleware: [{ name: "mw-high" }],
        soul: "SOUL.md",
        permissions: { allow: ["*"] },
      },
      regResult.value,
      makeFullContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    const names = result.value.middleware.map((mw) => mw.name);
    expect(names).toEqual(["permissions", "soul", "mw-high"]);
  });

  test("aggregates errors across multiple sections", async () => {
    // Registry with soul but no model and no permissions
    const regResult = createRegistry([makeSoulDescriptor()]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveManifest(
      {
        model: { name: "nonexistent:model" },
        soul: "SOUL.md",
        permissions: { allow: ["*"] }, // No permissions descriptor
      },
      regResult.value,
      makeFullContext(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    // Should have errors for both permissions and model sections
    expect(result.error.message).toContain("error(s)");
  });

  test("skips soul and permissions when not in manifest", async () => {
    const regResult = createRegistry([makeModelDescriptor()]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveManifest(
      { model: { name: "mock:test-model" } },
      regResult.value,
      makeFullContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.middleware).toEqual([]);
  });

  test("returns error when model resolution fails", async () => {
    const regResult = createRegistry([makeModelDescriptor()]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveManifest(
      { model: { name: "mock:test-model" } },
      regResult.value,
      makeFullContext({ MOCK_API_KEY: "" }), // Empty key causes factory to throw
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.message).toContain("MOCK_API_KEY");
  });
});
