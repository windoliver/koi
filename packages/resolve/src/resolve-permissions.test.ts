/**
 * Tests for the permissions section resolver.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest, KoiMiddleware } from "@koi/core";
import { createRegistry } from "./registry.js";
import { resolvePermissions } from "./resolve-permissions.js";
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

const MOCK_CONTEXT_WITH_APPROVAL: ResolutionContext = {
  ...MOCK_CONTEXT,
  approvalHandler: {
    requestApproval: async () => true,
  },
};

function makePermsDescriptor(): BrickDescriptor<KoiMiddleware> {
  return {
    kind: "middleware",
    name: "@koi/middleware-permissions",
    aliases: ["permissions"],
    optionsValidator: (input: unknown) => ({ ok: true, value: input }),
    factory: (options): KoiMiddleware => ({
      name: "permissions",
      priority: 100,
      ...({ _testOptions: options } as Record<string, unknown>),
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolvePermissions", () => {
  test("returns undefined when no permissions defined", async () => {
    const regResult = createRegistry([makePermsDescriptor()]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolvePermissions(undefined, regResult.value, MOCK_CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeUndefined();
  });

  test("returns undefined when permissions are empty", async () => {
    const regResult = createRegistry([makePermsDescriptor()]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolvePermissions(
      { allow: [], deny: [], ask: [] },
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeUndefined();
  });

  test("resolves allow/deny rules", async () => {
    const regResult = createRegistry([makePermsDescriptor()]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolvePermissions(
      { allow: ["fs:*"], deny: ["rm:*"] },
      regResult.value,
      MOCK_CONTEXT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeDefined();
    expect(result.value?.name).toBe("permissions");
  });

  test("resolves ask rules with approvalHandler", async () => {
    const regResult = createRegistry([makePermsDescriptor()]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolvePermissions(
      { ask: ["deploy:*"] },
      regResult.value,
      MOCK_CONTEXT_WITH_APPROVAL,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeDefined();
    expect(result.value?.name).toBe("permissions");
  });

  test("returns VALIDATION when ask rules exist but no approvalHandler", async () => {
    const regResult = createRegistry([makePermsDescriptor()]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolvePermissions(
      { ask: ["deploy:*"] },
      regResult.value,
      MOCK_CONTEXT, // no approvalHandler
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("approvalHandler");
  });

  test("returns NOT_FOUND when permissions descriptor is missing", async () => {
    const regResult = createRegistry([]); // No descriptors
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolvePermissions({ allow: ["*"] }, regResult.value, MOCK_CONTEXT);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toContain("@koi/middleware-permissions");
  });
});
