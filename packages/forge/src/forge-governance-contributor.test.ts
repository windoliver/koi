import { describe, expect, test } from "bun:test";
import { GOVERNANCE_VARIABLES } from "@koi/core";
import { createDefaultForgeConfig } from "./config.js";
import {
  createForgeGovernanceContributor,
  FORGE_GOVERNANCE,
} from "./forge-governance-contributor.js";

describe("createForgeGovernanceContributor", () => {
  test("returns two variables: forge_depth and forge_budget", () => {
    const config = createDefaultForgeConfig();
    const contributor = createForgeGovernanceContributor(
      config,
      () => 0,
      () => 0,
    );
    const vars = contributor.variables();
    expect(vars).toHaveLength(2);
    expect(vars[0]?.name).toBe(GOVERNANCE_VARIABLES.FORGE_DEPTH);
    expect(vars[1]?.name).toBe(GOVERNANCE_VARIABLES.FORGE_BUDGET);
  });

  test("forge_depth passes when depth within limit", () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 2 });
    const contributor = createForgeGovernanceContributor(
      config,
      () => 1,
      () => 0,
    );
    const depthVar = contributor.variables()[0];
    expect(depthVar).toBeDefined();
    expect(depthVar?.check().ok).toBe(true);
  });

  test("forge_depth passes when depth equals limit", () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 2 });
    const contributor = createForgeGovernanceContributor(
      config,
      () => 2,
      () => 0,
    );
    const depthVar = contributor.variables()[0];
    expect(depthVar).toBeDefined();
    expect(depthVar?.check().ok).toBe(true);
  });

  test("forge_depth fails when depth exceeds limit", () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 1 });
    const contributor = createForgeGovernanceContributor(
      config,
      () => 2,
      () => 0,
    );
    const depthVar = contributor.variables()[0];
    expect(depthVar).toBeDefined();
    const result = depthVar?.check();
    expect(result?.ok).toBe(false);
    if (result !== undefined && !result.ok) {
      expect(result.variable).toBe(GOVERNANCE_VARIABLES.FORGE_DEPTH);
      expect(result.retryable).toBe(false);
    }
  });

  test("forge_budget passes when count below limit", () => {
    const config = createDefaultForgeConfig({ maxForgesPerSession: 5 });
    const contributor = createForgeGovernanceContributor(
      config,
      () => 0,
      () => 3,
    );
    const budgetVar = contributor.variables()[1];
    expect(budgetVar).toBeDefined();
    expect(budgetVar?.check().ok).toBe(true);
  });

  test("forge_budget fails when count at limit", () => {
    const config = createDefaultForgeConfig({ maxForgesPerSession: 3 });
    const contributor = createForgeGovernanceContributor(
      config,
      () => 0,
      () => 3,
    );
    const budgetVar = contributor.variables()[1];
    expect(budgetVar).toBeDefined();
    const result = budgetVar?.check();
    expect(result?.ok).toBe(false);
    if (result !== undefined && !result.ok) {
      expect(result.variable).toBe(GOVERNANCE_VARIABLES.FORGE_BUDGET);
      expect(result.retryable).toBe(true);
    }
  });

  test("read functions return current values", () => {
    // let justified: mutable counters for testing dynamic reads
    let depth = 0;
    let count = 0;
    const config = createDefaultForgeConfig({ maxForgeDepth: 5, maxForgesPerSession: 10 });
    const contributor = createForgeGovernanceContributor(
      config,
      () => depth,
      () => count,
    );
    const vars = contributor.variables();

    expect(vars[0]?.read()).toBe(0);
    expect(vars[1]?.read()).toBe(0);

    depth = 3;
    count = 7;
    expect(vars[0]?.read()).toBe(3);
    expect(vars[1]?.read()).toBe(7);
  });

  test("FORGE_GOVERNANCE token has correct prefix", () => {
    expect((FORGE_GOVERNANCE as string).startsWith("governance:contrib:")).toBe(true);
  });
});
