import { describe, expect, test } from "bun:test";
import type { GovernanceController } from "@koi/core/governance";
import type { GovernanceBackend } from "@koi/core/governance-backend";
import { DEFAULT_ALERT_THRESHOLDS, validateGovernanceConfig } from "./config.js";
import { createFlatRateCostCalculator } from "./cost-calculator.js";

const goodBackend: GovernanceBackend = { evaluator: { evaluate: () => ({ ok: true }) } };
const goodController: GovernanceController = {
  check: () => ({ ok: true }),
  checkAll: () => ({ ok: true }),
  record: () => undefined,
  snapshot: () => ({ timestamp: 0, readings: [], healthy: true, violations: [] }),
  variables: () => new Map(),
  reading: () => undefined,
};
const goodCost = createFlatRateCostCalculator({ m: { inputUsdPer1M: 1, outputUsdPer1M: 1 } });

describe("validateGovernanceConfig", () => {
  test("accepts minimal valid config", () => {
    const r = validateGovernanceConfig({
      backend: goodBackend,
      controller: goodController,
      cost: goodCost,
    });
    expect(r.ok).toBe(true);
  });

  test("rejects missing backend", () => {
    const r = validateGovernanceConfig({ controller: goodController, cost: goodCost });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("rejects missing controller", () => {
    const r = validateGovernanceConfig({ backend: goodBackend, cost: goodCost });
    expect(r.ok).toBe(false);
  });

  test("rejects missing cost", () => {
    const r = validateGovernanceConfig({ backend: goodBackend, controller: goodController });
    expect(r.ok).toBe(false);
  });

  test("rejects threshold out of [0,1]", () => {
    const r = validateGovernanceConfig({
      backend: goodBackend,
      controller: goodController,
      cost: goodCost,
      alertThresholds: [0.8, 1.5],
    });
    expect(r.ok).toBe(false);
  });

  test("rejects negative threshold", () => {
    const r = validateGovernanceConfig({
      backend: goodBackend,
      controller: goodController,
      cost: goodCost,
      alertThresholds: [-0.1],
    });
    expect(r.ok).toBe(false);
  });

  test("DEFAULT_ALERT_THRESHOLDS is [0.8, 0.95]", () => {
    expect(DEFAULT_ALERT_THRESHOLDS).toEqual([0.8, 0.95]);
  });
});
