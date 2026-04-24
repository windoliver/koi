import { describe, expect, it, test } from "bun:test";
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

  test("validateGovernanceConfig accepts valid perVariableThresholds", () => {
    const result = validateGovernanceConfig({
      backend: goodBackend,
      controller: goodController,
      cost: goodCost,
      perVariableThresholds: { cost_usd: [0.5, 0.95] },
    });
    expect(result.ok).toBe(true);
  });

  test("validateGovernanceConfig rejects perVariableThresholds value > 1", () => {
    const result = validateGovernanceConfig({
      backend: goodBackend,
      controller: goodController,
      cost: goodCost,
      perVariableThresholds: { cost_usd: [1.5] },
    });
    expect(result.ok).toBe(false);
  });

  test("validateGovernanceConfig rejects perVariableThresholds with non-array value", () => {
    const result = validateGovernanceConfig({
      backend: goodBackend,
      controller: goodController,
      cost: goodCost,
      perVariableThresholds: { cost_usd: 0.5 as unknown as readonly number[] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("cost_usd");
    }
  });
});

describe("validateGovernanceConfig — ask-verdict config", () => {
  const baseValid = {
    backend: { evaluator: { evaluate: () => ({ ok: true }) } },
    controller: {
      checkAll: async () => ({ ok: true }),
      record: async () => undefined,
      snapshot: () => ({}),
    },
    cost: { calculate: () => 0 },
  };

  it("accepts missing approvalTimeoutMs (defaulted later)", () => {
    const res = validateGovernanceConfig(baseValid);
    expect(res.ok).toBe(true);
  });

  it("rejects approvalTimeoutMs: 0", () => {
    const res = validateGovernanceConfig({ ...baseValid, approvalTimeoutMs: 0 });
    expect(res.ok).toBe(false);
  });

  it("rejects approvalTimeoutMs: -1", () => {
    const res = validateGovernanceConfig({ ...baseValid, approvalTimeoutMs: -1 });
    expect(res.ok).toBe(false);
  });

  it("rejects approvalTimeoutMs: NaN", () => {
    const res = validateGovernanceConfig({ ...baseValid, approvalTimeoutMs: Number.NaN });
    expect(res.ok).toBe(false);
  });

  it("rejects approvalTimeoutMs: '60'", () => {
    const res = validateGovernanceConfig({ ...baseValid, approvalTimeoutMs: "60" });
    expect(res.ok).toBe(false);
  });

  it("accepts approvalTimeoutMs: 60000", () => {
    const res = validateGovernanceConfig({ ...baseValid, approvalTimeoutMs: 60000 });
    expect(res.ok).toBe(true);
  });

  it("rejects onApprovalPersist that is not a function", () => {
    const res = validateGovernanceConfig({ ...baseValid, onApprovalPersist: "nope" });
    expect(res.ok).toBe(false);
  });

  it("accepts onApprovalPersist as a function", () => {
    const res = validateGovernanceConfig({
      ...baseValid,
      onApprovalPersist: () => undefined,
    });
    expect(res.ok).toBe(true);
  });
});
