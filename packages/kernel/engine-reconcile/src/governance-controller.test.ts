import { describe, expect, mock, test } from "bun:test";
import { GOVERNANCE_VARIABLES } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { createGovernanceController } from "./governance-controller.js";

describe("createGovernanceController", () => {
  // -------------------------------------------------------------------------
  // Registration & sealing
  // -------------------------------------------------------------------------

  test("registers a custom variable", () => {
    const builder = createGovernanceController();
    builder.register({
      name: "custom_var",
      read: () => 42,
      limit: 100,
      retryable: false,
      check: () => ({ ok: true }),
    });
    expect(builder.variables().has("custom_var")).toBe(true);
  });

  test("throws on register after seal", () => {
    const builder = createGovernanceController();
    builder.seal();
    expect(builder.sealed).toBe(true);
    expect(() =>
      builder.register({
        name: "late_var",
        read: () => 0,
        limit: 10,
        retryable: false,
        check: () => ({ ok: true }),
      }),
    ).toThrow(KoiRuntimeError);
  });

  test("sealed flag starts false", () => {
    const builder = createGovernanceController();
    expect(builder.sealed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Built-in variables
  // -------------------------------------------------------------------------

  test("has all built-in variables registered", () => {
    const ctrl = createGovernanceController();
    const vars = ctrl.variables();
    expect(vars.has(GOVERNANCE_VARIABLES.SPAWN_DEPTH)).toBe(true);
    expect(vars.has(GOVERNANCE_VARIABLES.SPAWN_COUNT)).toBe(true);
    expect(vars.has(GOVERNANCE_VARIABLES.TURN_COUNT)).toBe(true);
    expect(vars.has(GOVERNANCE_VARIABLES.TOKEN_USAGE)).toBe(true);
    expect(vars.has(GOVERNANCE_VARIABLES.DURATION_MS)).toBe(true);
    expect(vars.has(GOVERNANCE_VARIABLES.ERROR_RATE)).toBe(true);
    expect(vars.has(GOVERNANCE_VARIABLES.COST_USD)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // check() per variable
  // -------------------------------------------------------------------------

  test("spawn_depth: passes when depth within limit", async () => {
    const ctrl = createGovernanceController(
      { spawn: { maxDepth: 3, maxFanOut: 5 } },
      { agentDepth: 2 },
    );
    const result = await ctrl.check(GOVERNANCE_VARIABLES.SPAWN_DEPTH);
    expect(result.ok).toBe(true);
  });

  test("spawn_depth: passes when depth equals limit", async () => {
    const ctrl = createGovernanceController(
      { spawn: { maxDepth: 3, maxFanOut: 5 } },
      { agentDepth: 3 },
    );
    const result = await ctrl.check(GOVERNANCE_VARIABLES.SPAWN_DEPTH);
    expect(result.ok).toBe(true);
  });

  test("spawn_depth: fails when depth exceeds limit", async () => {
    const ctrl = createGovernanceController(
      { spawn: { maxDepth: 2, maxFanOut: 5 } },
      { agentDepth: 3 },
    );
    const result = await ctrl.check(GOVERNANCE_VARIABLES.SPAWN_DEPTH);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.variable).toBe(GOVERNANCE_VARIABLES.SPAWN_DEPTH);
      expect(result.retryable).toBe(false);
    }
  });

  test("spawn_count: passes when under limit", async () => {
    const ctrl = createGovernanceController({ spawn: { maxDepth: 3, maxFanOut: 2 } });
    ctrl.record({ kind: "spawn", depth: 1 });
    const result = await ctrl.check(GOVERNANCE_VARIABLES.SPAWN_COUNT);
    expect(result.ok).toBe(true);
  });

  test("spawn_count: fails when at limit", async () => {
    const ctrl = createGovernanceController({ spawn: { maxDepth: 3, maxFanOut: 2 } });
    ctrl.record({ kind: "spawn", depth: 1 });
    ctrl.record({ kind: "spawn", depth: 1 });
    const result = await ctrl.check(GOVERNANCE_VARIABLES.SPAWN_COUNT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.variable).toBe(GOVERNANCE_VARIABLES.SPAWN_COUNT);
      expect(result.retryable).toBe(true);
    }
  });

  test("turn_count: passes when under limit", async () => {
    const ctrl = createGovernanceController({
      iteration: { maxTurns: 3, maxTokens: 100000, maxDurationMs: 300000 },
    });
    ctrl.record({ kind: "turn" });
    ctrl.record({ kind: "turn" });
    const result = await ctrl.check(GOVERNANCE_VARIABLES.TURN_COUNT);
    expect(result.ok).toBe(true);
  });

  test("turn_count: fails when at limit", async () => {
    const ctrl = createGovernanceController({
      iteration: { maxTurns: 2, maxTokens: 100000, maxDurationMs: 300000 },
    });
    ctrl.record({ kind: "turn" });
    ctrl.record({ kind: "turn" });
    const result = await ctrl.check(GOVERNANCE_VARIABLES.TURN_COUNT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.variable).toBe(GOVERNANCE_VARIABLES.TURN_COUNT);
      expect(result.retryable).toBe(false);
    }
  });

  test("token_usage: passes when under limit", async () => {
    const ctrl = createGovernanceController({
      iteration: { maxTurns: 25, maxTokens: 100, maxDurationMs: 300000 },
    });
    ctrl.record({ kind: "token_usage", count: 50 });
    const result = await ctrl.check(GOVERNANCE_VARIABLES.TOKEN_USAGE);
    expect(result.ok).toBe(true);
  });

  test("token_usage: fails when at limit", async () => {
    const ctrl = createGovernanceController({
      iteration: { maxTurns: 25, maxTokens: 100, maxDurationMs: 300000 },
    });
    ctrl.record({ kind: "token_usage", count: 100 });
    const result = await ctrl.check(GOVERNANCE_VARIABLES.TOKEN_USAGE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.variable).toBe(GOVERNANCE_VARIABLES.TOKEN_USAGE);
    }
  });

  test("check returns error for unknown variable", async () => {
    const ctrl = createGovernanceController();
    const result = await ctrl.check("nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.variable).toBe("nonexistent");
      expect(result.reason).toContain("Unknown");
    }
  });

  // -------------------------------------------------------------------------
  // checkAll()
  // -------------------------------------------------------------------------

  test("checkAll: passes when all variables within limits", async () => {
    const ctrl = createGovernanceController();
    const result = await ctrl.checkAll();
    expect(result.ok).toBe(true);
  });

  test("checkAll: returns first violation", async () => {
    const ctrl = createGovernanceController({
      iteration: { maxTurns: 1, maxTokens: 100000, maxDurationMs: 300000 },
    });
    ctrl.record({ kind: "turn" });
    const result = await ctrl.checkAll();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.variable).toBe(GOVERNANCE_VARIABLES.TURN_COUNT);
    }
  });

  // -------------------------------------------------------------------------
  // record() event dispatcher
  // -------------------------------------------------------------------------

  test("record turn increments turn counter", () => {
    const ctrl = createGovernanceController();
    ctrl.record({ kind: "turn" });
    ctrl.record({ kind: "turn" });
    const r = ctrl.reading(GOVERNANCE_VARIABLES.TURN_COUNT);
    expect(r?.current).toBe(2);
  });

  test("record spawn increments spawn count", () => {
    const ctrl = createGovernanceController();
    ctrl.record({ kind: "spawn", depth: 1 });
    const r = ctrl.reading(GOVERNANCE_VARIABLES.SPAWN_COUNT);
    expect(r?.current).toBe(1);
  });

  test("record spawn_release decrements spawn count", () => {
    const ctrl = createGovernanceController();
    ctrl.record({ kind: "spawn", depth: 1 });
    ctrl.record({ kind: "spawn", depth: 1 });
    ctrl.record({ kind: "spawn_release" });
    const r = ctrl.reading(GOVERNANCE_VARIABLES.SPAWN_COUNT);
    expect(r?.current).toBe(1);
  });

  test("spawn_release over-release clamps to 0", () => {
    const ctrl = createGovernanceController();
    ctrl.record({ kind: "spawn_release" });
    ctrl.record({ kind: "spawn_release" });
    const r = ctrl.reading(GOVERNANCE_VARIABLES.SPAWN_COUNT);
    expect(r?.current).toBe(0);
  });

  test("record token_usage accumulates", () => {
    const ctrl = createGovernanceController();
    ctrl.record({ kind: "token_usage", count: 50 });
    ctrl.record({ kind: "token_usage", count: 30 });
    const r = ctrl.reading(GOVERNANCE_VARIABLES.TOKEN_USAGE);
    expect(r?.current).toBe(80);
  });

  test("record tool_error increments error window and total", () => {
    const ctrl = createGovernanceController({ errorRate: { windowMs: 60000, threshold: 0.5 } });
    ctrl.record({ kind: "tool_error", toolName: "test" });
    ctrl.record({ kind: "tool_success", toolName: "test" });
    // 1 error / 2 total = 0.5 rate
    const r = ctrl.reading(GOVERNANCE_VARIABLES.ERROR_RATE);
    expect(r).toBeDefined();
    expect(r?.current).toBeCloseTo(0.5);
  });

  test("record tool_success increments total only", () => {
    const ctrl = createGovernanceController({ errorRate: { windowMs: 60000, threshold: 0.5 } });
    ctrl.record({ kind: "tool_success", toolName: "test" });
    ctrl.record({ kind: "tool_success", toolName: "test" });
    const r = ctrl.reading(GOVERNANCE_VARIABLES.ERROR_RATE);
    expect(r).toBeDefined();
    expect(r?.current).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Error rate
  // -------------------------------------------------------------------------

  test("error rate check passes when rate below threshold", async () => {
    const ctrl = createGovernanceController({ errorRate: { windowMs: 60000, threshold: 0.5 } });
    ctrl.record({ kind: "tool_error", toolName: "t" });
    ctrl.record({ kind: "tool_success", toolName: "t" });
    ctrl.record({ kind: "tool_success", toolName: "t" });
    ctrl.record({ kind: "tool_success", toolName: "t" });
    // 1/4 = 0.25 < 0.5
    const result = await ctrl.check(GOVERNANCE_VARIABLES.ERROR_RATE);
    expect(result.ok).toBe(true);
  });

  test("error rate check fails when rate at threshold (above minSampleSize)", async () => {
    const ctrl = createGovernanceController({
      errorRate: { windowMs: 60000, threshold: 0.5, minSampleSize: 2 },
    });
    ctrl.record({ kind: "tool_error", toolName: "t" });
    ctrl.record({ kind: "tool_success", toolName: "t" });
    // 1/2 = 0.5 >= 0.5, and 2 >= minSampleSize(2)
    const result = await ctrl.check(GOVERNANCE_VARIABLES.ERROR_RATE);
    expect(result.ok).toBe(false);
  });

  test("error rate check passes when below minSampleSize", async () => {
    const ctrl = createGovernanceController({
      errorRate: { windowMs: 60000, threshold: 0.5, minSampleSize: 3 },
    });
    ctrl.record({ kind: "tool_error", toolName: "t" });
    // 1/1 = 1.0 >= 0.5, but only 1 call < minSampleSize(3) → passes
    const result = await ctrl.check(GOVERNANCE_VARIABLES.ERROR_RATE);
    expect(result.ok).toBe(true);
  });

  test("error rate uses windowed denominator, not lifetime total", () => {
    // Use a very short window so we can demonstrate the windowed behavior.
    // With lifetime denominator, old successes would dilute the rate.
    const ctrl = createGovernanceController({ errorRate: { windowMs: 60000, threshold: 0.5 } });

    // Record 2 successes and 1 error — all within the window
    ctrl.record({ kind: "tool_success", toolName: "t" });
    ctrl.record({ kind: "tool_success", toolName: "t" });
    ctrl.record({ kind: "tool_error", toolName: "t" });

    // 1 error / 3 total in window = 0.333...
    const r = ctrl.reading(GOVERNANCE_VARIABLES.ERROR_RATE);
    expect(r).toBeDefined();
    expect(r?.current).toBeCloseTo(1 / 3);
  });

  test("error rate is 0 when no tool calls recorded", async () => {
    const ctrl = createGovernanceController();
    const result = await ctrl.check(GOVERNANCE_VARIABLES.ERROR_RATE);
    expect(result.ok).toBe(true);
    const r = ctrl.reading(GOVERNANCE_VARIABLES.ERROR_RATE);
    expect(r?.current).toBe(0);
  });

  // -------------------------------------------------------------------------
  // snapshot()
  // -------------------------------------------------------------------------

  test("snapshot returns frozen object with correct readings", async () => {
    const ctrl = createGovernanceController();
    ctrl.record({ kind: "turn" });
    ctrl.record({ kind: "token_usage", count: 50 });
    const snap = await ctrl.snapshot();
    expect(snap.healthy).toBe(true);
    expect(snap.violations).toHaveLength(0);
    expect(snap.readings.length).toBeGreaterThanOrEqual(7);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.readings)).toBe(true);
    expect(Object.isFrozen(snap.violations)).toBe(true);
  });

  test("snapshot reports violations when limits exceeded", async () => {
    const ctrl = createGovernanceController({
      iteration: { maxTurns: 1, maxTokens: 100000, maxDurationMs: 300000 },
    });
    ctrl.record({ kind: "turn" });
    const snap = await ctrl.snapshot();
    expect(snap.healthy).toBe(false);
    expect(snap.violations).toContain(GOVERNANCE_VARIABLES.TURN_COUNT);
  });

  test("snapshot utilization is clamped to 0-1", async () => {
    const ctrl = createGovernanceController({
      iteration: { maxTurns: 2, maxTokens: 100000, maxDurationMs: 300000 },
    });
    ctrl.record({ kind: "turn" });
    ctrl.record({ kind: "turn" });
    ctrl.record({ kind: "turn" });
    const snap = await ctrl.snapshot();
    const turnReading = snap.readings.find((r) => r.name === GOVERNANCE_VARIABLES.TURN_COUNT);
    expect(turnReading).toBeDefined();
    expect(turnReading?.utilization).toBeLessThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // reading()
  // -------------------------------------------------------------------------

  test("reading returns undefined for unknown variable", () => {
    const ctrl = createGovernanceController();
    expect(ctrl.reading("unknown")).toBeUndefined();
  });

  test("reading returns correct sensor data", () => {
    const ctrl = createGovernanceController({
      iteration: { maxTurns: 10, maxTokens: 100000, maxDurationMs: 300000 },
    });
    ctrl.record({ kind: "turn" });
    ctrl.record({ kind: "turn" });
    ctrl.record({ kind: "turn" });
    const r = ctrl.reading(GOVERNANCE_VARIABLES.TURN_COUNT);
    expect(r).toBeDefined();
    expect(r?.name).toBe(GOVERNANCE_VARIABLES.TURN_COUNT);
    expect(r?.current).toBe(3);
    expect(r?.limit).toBe(10);
    expect(r?.utilization).toBeCloseTo(0.3);
  });

  // -------------------------------------------------------------------------
  // Duration variable
  // -------------------------------------------------------------------------

  test("duration reads elapsed time", () => {
    const ctrl = createGovernanceController();
    const r = ctrl.reading(GOVERNANCE_VARIABLES.DURATION_MS);
    expect(r).toBeDefined();
    // Just created — should be very small
    expect(r?.current).toBeLessThan(1000);
  });

  // -------------------------------------------------------------------------
  // Cost variable
  // -------------------------------------------------------------------------

  test("cost_usd: disabled by default (maxCostUsd = 0)", async () => {
    const ctrl = createGovernanceController();
    ctrl.record({ kind: "token_usage", count: 100, inputTokens: 50, outputTokens: 50 });
    const result = await ctrl.check(GOVERNANCE_VARIABLES.COST_USD);
    expect(result.ok).toBe(true); // always passes when disabled
  });

  test("cost_usd: accumulates cost from input/output token pricing", () => {
    const ctrl = createGovernanceController({
      cost: { maxCostUsd: 1.0, costPerInputToken: 0.000003, costPerOutputToken: 0.000015 },
    });
    // 1000 input tokens @ $3/1M + 500 output tokens @ $15/1M
    // = 0.003 + 0.0075 = 0.0105
    ctrl.record({ kind: "token_usage", count: 1500, inputTokens: 1000, outputTokens: 500 });
    const r = ctrl.reading(GOVERNANCE_VARIABLES.COST_USD);
    expect(r).toBeDefined();
    expect(r?.current).toBeCloseTo(0.0105);
  });

  test("cost_usd: fails when accumulated cost reaches limit", async () => {
    const ctrl = createGovernanceController({
      cost: { maxCostUsd: 0.01, costPerInputToken: 0.000003, costPerOutputToken: 0.000015 },
    });
    // Record enough tokens to exceed $0.01
    // 1000 input + 500 output = $0.0105
    ctrl.record({ kind: "token_usage", count: 1500, inputTokens: 1000, outputTokens: 500 });
    const result = await ctrl.check(GOVERNANCE_VARIABLES.COST_USD);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.variable).toBe(GOVERNANCE_VARIABLES.COST_USD);
      expect(result.retryable).toBe(false);
    }
  });

  test("cost_usd: does not accumulate when no input/output breakdown", () => {
    const ctrl = createGovernanceController({
      cost: { maxCostUsd: 1.0, costPerInputToken: 0.000003, costPerOutputToken: 0.000015 },
    });
    // Legacy event without breakdown — cost stays at 0
    ctrl.record({ kind: "token_usage", count: 1000 });
    const r = ctrl.reading(GOVERNANCE_VARIABLES.COST_USD);
    expect(r?.current).toBe(0);
  });

  test("cost_usd: accumulates across multiple model calls", () => {
    const ctrl = createGovernanceController({
      cost: { maxCostUsd: 1.0, costPerInputToken: 0.00001, costPerOutputToken: 0.00003 },
    });
    ctrl.record({ kind: "token_usage", count: 200, inputTokens: 100, outputTokens: 100 });
    ctrl.record({ kind: "token_usage", count: 200, inputTokens: 100, outputTokens: 100 });
    // 200 input @ $10/1M + 200 output @ $30/1M = 0.002 + 0.006 = 0.008
    const r = ctrl.reading(GOVERNANCE_VARIABLES.COST_USD);
    expect(r?.current).toBeCloseTo(0.008);
  });

  // -------------------------------------------------------------------------
  // Custom variable override
  // -------------------------------------------------------------------------

  test("custom variable overrides built-in with same name", async () => {
    const ctrl = createGovernanceController();
    const customCheck = mock(() => ({
      ok: false as const,
      variable: GOVERNANCE_VARIABLES.TURN_COUNT,
      reason: "custom denial",
      retryable: true,
    }));
    ctrl.register({
      name: GOVERNANCE_VARIABLES.TURN_COUNT,
      read: () => 999,
      limit: 1000,
      retryable: true,
      check: customCheck,
    });
    const result = await ctrl.check(GOVERNANCE_VARIABLES.TURN_COUNT);
    expect(result.ok).toBe(false);
    expect(customCheck).toHaveBeenCalledTimes(1);
  });
});
