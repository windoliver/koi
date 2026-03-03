import { describe, expect, test } from "bun:test";
import type { GovernanceCheck, GovernanceSnapshot } from "@koi/core";
import { createMockGovernanceController } from "./governance.js";

describe("createMockGovernanceController", () => {
  test("defaults check to ok", () => {
    const ctrl = createMockGovernanceController();
    expect(ctrl.check("any_variable")).toEqual({ ok: true });
  });

  test("defaults checkAll to ok", () => {
    const ctrl = createMockGovernanceController();
    expect(ctrl.checkAll()).toEqual({ ok: true });
  });

  test("defaults record to no-op", () => {
    const ctrl = createMockGovernanceController();
    // Should not throw
    ctrl.record({ kind: "turn" });
  });

  test("defaults snapshot to healthy empty", () => {
    const ctrl = createMockGovernanceController();
    const snap = ctrl.snapshot() as GovernanceSnapshot;
    expect(snap.healthy).toBe(true);
    expect(snap.readings).toHaveLength(0);
    expect(snap.violations).toHaveLength(0);
  });

  test("defaults variables to empty map", () => {
    const ctrl = createMockGovernanceController();
    const vars = ctrl.variables();
    expect(vars.size).toBe(0);
  });

  test("defaults reading to undefined", () => {
    const ctrl = createMockGovernanceController();
    expect(ctrl.reading("any")).toBeUndefined();
  });

  test("overrides check", () => {
    const failing: GovernanceCheck = {
      ok: false,
      variable: "test_var",
      reason: "test failure",
      retryable: false,
    };
    const ctrl = createMockGovernanceController({
      check: () => failing,
    });
    expect(ctrl.check("test_var")).toEqual(failing);
  });

  test("overrides checkAll", () => {
    const failing: GovernanceCheck = {
      ok: false,
      variable: "test_var",
      reason: "over limit",
      retryable: true,
    };
    const ctrl = createMockGovernanceController({
      checkAll: () => failing,
    });
    expect(ctrl.checkAll()).toEqual(failing);
  });

  test("overrides record", () => {
    // let justified: mutable counter for testing record calls
    let count = 0;
    const ctrl = createMockGovernanceController({
      record: () => {
        count++;
      },
    });
    ctrl.record({ kind: "turn" });
    ctrl.record({ kind: "spawn", depth: 1 });
    expect(count).toBe(2);
  });
});
