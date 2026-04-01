/**
 * Tests for publish-relevant governance paths in the governance module.
 */

import { describe, expect, test } from "bun:test";
import type { ToolPolicy } from "@koi/core";
import type { ForgeContext } from "@koi/forge-types";
import { createDefaultForgeConfig } from "@koi/forge-types";
import { checkGovernance, checkScopePromotion, validatePolicyChange } from "./governance.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createContext(overrides?: Partial<ForgeContext>): ForgeContext {
  return {
    agentId: "test-agent",
    sessionId: "test-session",
    depth: 0,
    forgesThisSession: 0,
    ...overrides,
  };
}

const SANDBOXED_POLICY: ToolPolicy = {
  sandbox: true,
  capabilities: {},
} as const;

const UNSANDBOXED_POLICY: ToolPolicy = {
  sandbox: false,
  capabilities: {},
} as const;

// ---------------------------------------------------------------------------
// checkScopePromotion
// ---------------------------------------------------------------------------

describe("checkScopePromotion", () => {
  test("promotion to global requires governance check", () => {
    const config = createDefaultForgeConfig({
      scopePromotion: { requireHumanApproval: true },
    });
    const result = checkScopePromotion("agent", "global", config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requiresHumanApproval).toBe(true);
      expect(result.value.message).toBeDefined();
    }
  });

  test("same scope needs no approval", () => {
    const config = createDefaultForgeConfig({
      scopePromotion: { requireHumanApproval: true },
    });
    const result = checkScopePromotion("agent", "agent", config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requiresHumanApproval).toBe(false);
    }
  });

  test("downward scope needs no approval", () => {
    const config = createDefaultForgeConfig({
      scopePromotion: { requireHumanApproval: true },
    });
    const result = checkScopePromotion("global", "agent", config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requiresHumanApproval).toBe(false);
    }
  });

  test("promotion without requireHumanApproval passes freely", () => {
    const config = createDefaultForgeConfig({
      scopePromotion: { requireHumanApproval: false },
    });
    const result = checkScopePromotion("agent", "global", config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requiresHumanApproval).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// checkGovernance
// ---------------------------------------------------------------------------

describe("checkGovernance", () => {
  test("disabled forge returns error", () => {
    const config = createDefaultForgeConfig({ enabled: false });
    const context = createContext();
    const result = checkGovernance(context, config);
    expect(result).toEqual({
      ok: false,
      error: { stage: "governance", code: "FORGE_DISABLED", message: expect.any(String) },
    });
  });

  test("enabled forge within limits passes", () => {
    const config = createDefaultForgeConfig({
      enabled: true,
      maxForgeDepth: 3,
      maxForgesPerSession: 10,
    });
    const context = createContext({ depth: 1, forgesThisSession: 2 });
    const result = checkGovernance(context, config);
    expect(result).toEqual({ ok: true, value: undefined });
  });

  test("exceeding max depth returns error", () => {
    const config = createDefaultForgeConfig({ enabled: true, maxForgeDepth: 1 });
    const context = createContext({ depth: 2 });
    const result = checkGovernance(context, config);
    expect(result).toEqual({
      ok: false,
      error: { stage: "governance", code: "MAX_DEPTH", message: expect.any(String) },
    });
  });

  test("exceeding session budget returns error", () => {
    const config = createDefaultForgeConfig({ enabled: true, maxForgesPerSession: 3 });
    const context = createContext({ forgesThisSession: 3 });
    const result = checkGovernance(context, config);
    expect(result).toEqual({
      ok: false,
      error: { stage: "governance", code: "MAX_SESSION_FORGES", message: expect.any(String) },
    });
  });
});

// ---------------------------------------------------------------------------
// validatePolicyChange
// ---------------------------------------------------------------------------

describe("validatePolicyChange", () => {
  test("re-sandboxing is always allowed", () => {
    const result = validatePolicyChange(UNSANDBOXED_POLICY, SANDBOXED_POLICY, "agent");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ from: UNSANDBOXED_POLICY, to: SANDBOXED_POLICY });
    }
  });

  test("unsandboxing by agent is denied", () => {
    const result = validatePolicyChange(SANDBOXED_POLICY, UNSANDBOXED_POLICY, "agent");
    expect(result).toEqual({
      ok: false,
      error: {
        stage: "governance",
        code: "TRUST_DEMOTION_NOT_ALLOWED",
        message: expect.any(String),
      },
    });
  });

  test("unsandboxing by system is allowed", () => {
    const result = validatePolicyChange(SANDBOXED_POLICY, UNSANDBOXED_POLICY, "system");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ from: SANDBOXED_POLICY, to: UNSANDBOXED_POLICY });
    }
  });
});
