/**
 * Tests for the soul section resolver.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest, KoiMiddleware } from "@koi/core";
import { createRegistry } from "./registry.js";
import { resolveSoul } from "./resolve-soul.js";
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
  manifestDir: "/tmp/test-agent",
  manifest: MOCK_MANIFEST,
  env: {},
};

function makeSoulDescriptor(): BrickDescriptor<KoiMiddleware> {
  return {
    kind: "middleware",
    name: "@koi/middleware-soul",
    aliases: ["soul"],
    optionsValidator: (input: unknown) => ({ ok: true, value: input }),
    factory: (options): KoiMiddleware => ({
      name: "soul",
      describeCapabilities: () => undefined,
      priority: 500,
      // Store options for test assertions
      ...({ _testOptions: options } as Record<string, unknown>),
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveSoul", () => {
  test("returns undefined when no soul or user in manifest", async () => {
    const regResult = createRegistry([makeSoulDescriptor()]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSoul({}, regResult.value, MOCK_CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeUndefined();
  });

  test("returns undefined when both soul and user are undefined", async () => {
    const regResult = createRegistry([makeSoulDescriptor()]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSoul(
      { soul: undefined, user: undefined },
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeUndefined();
  });

  test("resolves soul only", async () => {
    const regResult = createRegistry([makeSoulDescriptor()]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSoul({ soul: "SOUL.md" }, regResult.value, MOCK_CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeDefined();
    expect(result.value?.name).toBe("soul");
  });

  test("resolves user only", async () => {
    const regResult = createRegistry([makeSoulDescriptor()]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSoul({ user: "USER.md" }, regResult.value, MOCK_CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeDefined();
    expect(result.value?.name).toBe("soul");
  });

  test("resolves both soul and user", async () => {
    const regResult = createRegistry([makeSoulDescriptor()]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSoul(
      { soul: "SOUL.md", user: { path: "USER.md", maxTokens: 1000 } },
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeDefined();
    const testData = result.value as unknown as Record<string, unknown>;
    const opts = testData._testOptions as Record<string, unknown>;
    expect(opts.soul).toBe("SOUL.md");
    expect(opts.user).toEqual({ path: "USER.md", maxTokens: 1000 });
  });

  test("returns NOT_FOUND when soul descriptor is missing", async () => {
    const regResult = createRegistry([]); // No descriptors
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSoul({ soul: "SOUL.md" }, regResult.value, MOCK_CONTEXT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toContain("@koi/middleware-soul");
  });
});
