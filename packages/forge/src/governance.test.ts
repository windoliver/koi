import { describe, expect, test } from "bun:test";
import { createDefaultForgeConfig } from "./config.js";
import { checkGovernance, checkScopePromotion } from "./governance.js";
import type { ForgeContext } from "./types.js";

const DEFAULT_CONTEXT: ForgeContext = {
  agentId: "agent-1",
  depth: 0,
  sessionId: "session-1",
  forgesThisSession: 0,
};

describe("checkGovernance", () => {
  test("passes with default config and fresh context", () => {
    const config = createDefaultForgeConfig();
    const result = checkGovernance(DEFAULT_CONTEXT, config);
    expect(result.ok).toBe(true);
  });

  test("rejects when forge is disabled", () => {
    const config = createDefaultForgeConfig({ enabled: false });
    const result = checkGovernance(DEFAULT_CONTEXT, config);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "governance") {
      expect(result.error.code).toBe("FORGE_DISABLED");
    }
  });

  test("rejects when depth exceeds max", () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 1 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, depth: 2 };
    const result = checkGovernance(context, config);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "governance") {
      expect(result.error.code).toBe("MAX_DEPTH");
    }
  });

  test("allows depth equal to max", () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 2 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, depth: 2 };
    const result = checkGovernance(context, config);
    expect(result.ok).toBe(true);
  });

  test("rejects when session forges exceed max", () => {
    const config = createDefaultForgeConfig({ maxForgesPerSession: 3 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, forgesThisSession: 3 };
    const result = checkGovernance(context, config);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "governance") {
      expect(result.error.code).toBe("MAX_SESSION_FORGES");
    }
  });

  test("allows forges below max", () => {
    const config = createDefaultForgeConfig({ maxForgesPerSession: 3 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, forgesThisSession: 2 };
    const result = checkGovernance(context, config);
    expect(result.ok).toBe(true);
  });
});

describe("checkScopePromotion", () => {
  test("allows same-scope (no promotion needed)", () => {
    const config = createDefaultForgeConfig();
    const result = checkScopePromotion("agent", "agent", "sandbox", config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requiresHumanApproval).toBe(false);
    }
  });

  test("allows downgrade (global to agent)", () => {
    const config = createDefaultForgeConfig();
    const result = checkScopePromotion("global", "agent", "sandbox", config);
    expect(result.ok).toBe(true);
  });

  test("rejects zone promotion with insufficient trust", () => {
    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "verified",
        minTrustForGlobal: "promoted",
      },
    });
    const result = checkScopePromotion("agent", "zone", "sandbox", config);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "governance") {
      expect(result.error.code).toBe("SCOPE_VIOLATION");
    }
  });

  test("allows zone promotion with sufficient trust", () => {
    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "verified",
        minTrustForGlobal: "promoted",
      },
    });
    const result = checkScopePromotion("agent", "zone", "verified", config);
    expect(result.ok).toBe(true);
  });

  test("rejects global promotion with insufficient trust", () => {
    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: false,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "promoted",
      },
    });
    const result = checkScopePromotion("agent", "global", "verified", config);
    expect(result.ok).toBe(false);
  });

  test("returns requiresHumanApproval when enabled", () => {
    const config = createDefaultForgeConfig({
      scopePromotion: {
        requireHumanApproval: true,
        minTrustForZone: "sandbox",
        minTrustForGlobal: "sandbox",
      },
    });
    const result = checkScopePromotion("agent", "zone", "sandbox", config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requiresHumanApproval).toBe(true);
      expect(result.value.message).toContain("human approval");
    }
  });
});
