import { describe, expect, test } from "bun:test";
import type { GovernanceCheck } from "@koi/core";
import { createMockGovernanceController } from "@koi/test-utils";
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
  test("passes with default config and fresh context", async () => {
    const config = createDefaultForgeConfig();
    const result = await checkGovernance(DEFAULT_CONTEXT, config);
    expect(result.ok).toBe(true);
  });

  test("rejects when forge is disabled", async () => {
    const config = createDefaultForgeConfig({ enabled: false });
    const result = await checkGovernance(DEFAULT_CONTEXT, config);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "governance") {
      expect(result.error.code).toBe("FORGE_DISABLED");
    }
  });

  test("rejects when depth exceeds max", async () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 1 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, depth: 2 };
    const result = await checkGovernance(context, config);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "governance") {
      expect(result.error.code).toBe("MAX_DEPTH");
    }
  });

  test("allows depth equal to max", async () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 2 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, depth: 2 };
    const result = await checkGovernance(context, config);
    expect(result.ok).toBe(true);
  });

  test("rejects when session forges exceed max", async () => {
    const config = createDefaultForgeConfig({ maxForgesPerSession: 3 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, forgesThisSession: 3 };
    const result = await checkGovernance(context, config);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "governance") {
      expect(result.error.code).toBe("MAX_SESSION_FORGES");
    }
  });

  test("allows forges below max", async () => {
    const config = createDefaultForgeConfig({ maxForgesPerSession: 3 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, forgesThisSession: 2 };
    const result = await checkGovernance(context, config);
    expect(result.ok).toBe(true);
  });

  test("depth 0 allows all 6 primordial tools", async () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 2 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, depth: 0 };
    for (const toolName of [
      "forge_tool",
      "forge_skill",
      "forge_agent",
      "search_forge",
      "compose_forge",
      "promote_forge",
    ]) {
      const result = await checkGovernance(context, config, toolName);
      expect(result.ok).toBe(true);
    }
  });

  test("depth 1 allows forge_tool, forge_skill, search_forge, promote_forge", async () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 2 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, depth: 1 };
    for (const toolName of ["forge_tool", "forge_skill", "search_forge", "promote_forge"]) {
      const result = await checkGovernance(context, config, toolName);
      expect(result.ok).toBe(true);
    }
  });

  test("depth 1 rejects forge_agent and compose_forge", async () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 2 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, depth: 1 };
    for (const toolName of ["forge_agent", "compose_forge"]) {
      const result = await checkGovernance(context, config, toolName);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.stage === "governance") {
        expect(result.error.code).toBe("DEPTH_TOOL_RESTRICTED");
      }
    }
  });

  test("depth 2+ allows only search_forge", async () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 3 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, depth: 2 };
    const allowed = await checkGovernance(context, config, "search_forge");
    expect(allowed.ok).toBe(true);

    for (const toolName of [
      "forge_tool",
      "forge_skill",
      "forge_agent",
      "compose_forge",
      "promote_forge",
    ]) {
      const result = await checkGovernance(context, config, toolName);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.stage === "governance") {
        expect(result.error.code).toBe("DEPTH_TOOL_RESTRICTED");
      }
    }
  });

  test("skips tool filtering when toolName not provided", async () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 3 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, depth: 2 };
    const result = await checkGovernance(context, config);
    expect(result.ok).toBe(true);
  });

  // --- Controller-delegated path ---

  test("delegates to controller when provided — passes", async () => {
    const config = createDefaultForgeConfig();
    const controller = createMockGovernanceController();
    const result = await checkGovernance(DEFAULT_CONTEXT, config, undefined, controller);
    expect(result.ok).toBe(true);
  });

  test("delegates to controller — forge_depth failure maps to MAX_DEPTH", async () => {
    const config = createDefaultForgeConfig();
    const controller = createMockGovernanceController({
      check: (variable: string): GovernanceCheck => {
        if (variable === "forge_depth") {
          return { ok: false, variable: "forge_depth", reason: "too deep", retryable: false };
        }
        return { ok: true };
      },
    });
    const result = await checkGovernance(DEFAULT_CONTEXT, config, undefined, controller);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "governance") {
      expect(result.error.code).toBe("MAX_DEPTH");
    }
  });

  test("delegates to controller — forge_budget failure maps to MAX_SESSION_FORGES", async () => {
    const config = createDefaultForgeConfig();
    const controller = createMockGovernanceController({
      check: (variable: string): GovernanceCheck => {
        if (variable === "forge_budget") {
          return {
            ok: false,
            variable: "forge_budget",
            reason: "budget exhausted",
            retryable: true,
          };
        }
        return { ok: true };
      },
    });
    const result = await checkGovernance(DEFAULT_CONTEXT, config, undefined, controller);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "governance") {
      expect(result.error.code).toBe("MAX_SESSION_FORGES");
    }
  });

  test("controller path still checks config.enabled first", async () => {
    const config = createDefaultForgeConfig({ enabled: false });
    const controller = createMockGovernanceController();
    const result = await checkGovernance(DEFAULT_CONTEXT, config, undefined, controller);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "governance") {
      expect(result.error.code).toBe("FORGE_DISABLED");
    }
  });

  test("controller path still enforces depth-aware tool filtering", async () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 3 });
    const context: ForgeContext = { ...DEFAULT_CONTEXT, depth: 2 };
    const controller = createMockGovernanceController();
    const result = await checkGovernance(context, config, "forge_agent", controller);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "governance") {
      expect(result.error.code).toBe("DEPTH_TOOL_RESTRICTED");
    }
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
