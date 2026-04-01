import { describe, expect, test } from "bun:test";
import { GOVERNANCE_VARIABLES } from "@koi/core";
import {
  COMPACTOR_GOVERNANCE,
  createCompactorGovernanceContributor,
} from "./compactor-governance-contributor.js";

describe("createCompactorGovernanceContributor", () => {
  test("returns 1 variable named context_occupancy", () => {
    const contributor = createCompactorGovernanceContributor(() => 0, 200_000);
    const vars = contributor.variables();
    expect(vars).toHaveLength(1);
    expect(vars[0]?.name).toBe(GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY);
  });

  test("check() always returns {ok: true} even at 100% occupancy", () => {
    const contributor = createCompactorGovernanceContributor(() => 200_000, 200_000);
    const result = contributor.variables()[0]?.check();
    expect(result).toEqual({ ok: true });
  });

  test("read() returns value from closure", () => {
    // let justified: mutable to simulate changing token count
    let tokenCount = 0;
    const contributor = createCompactorGovernanceContributor(() => tokenCount, 200_000);
    const variable = contributor.variables()[0];
    expect(variable).toBeDefined();
    if (variable === undefined) return;
    expect(variable.read()).toBe(0);
    tokenCount = 100_000;
    expect(variable.read()).toBe(100_000);
    tokenCount = 200_000;
    expect(variable.read()).toBe(200_000);
  });

  test("limit equals contextWindowSize", () => {
    const contributor = createCompactorGovernanceContributor(() => 0, 128_000);
    expect(contributor.variables()[0]?.limit).toBe(128_000);
  });

  test("retryable is false", () => {
    const contributor = createCompactorGovernanceContributor(() => 0, 200_000);
    expect(contributor.variables()[0]?.retryable).toBe(false);
  });

  test("has a description", () => {
    const contributor = createCompactorGovernanceContributor(() => 0, 200_000);
    expect(contributor.variables()[0]?.description).toBeDefined();
    expect(typeof contributor.variables()[0]?.description).toBe("string");
  });

  test("COMPACTOR_GOVERNANCE token has correct governance:contrib: prefix", () => {
    expect((COMPACTOR_GOVERNANCE as string).startsWith("governance:contrib:")).toBe(true);
  });
});
