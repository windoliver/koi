import { beforeEach, describe, expect, test } from "bun:test";
import { GOVERNANCE_VARIABLES } from "@koi/core/governance";
import { createInMemoryController } from "../in-memory-controller.js";

describe("createInMemoryController", () => {
  describe("variables()", () => {
    test("exposes all ten well-known governance variables", () => {
      const controller = createInMemoryController({});
      const names = [...controller.variables().keys()].sort();
      const expected = Object.values(GOVERNANCE_VARIABLES).slice().sort();
      expect(names).toEqual(expected);
    });

    test("limits default to Infinity when unspecified — every sensor is zero-config no-op", () => {
      const controller = createInMemoryController({});
      const vars = controller.variables();
      for (const name of Object.values(GOVERNANCE_VARIABLES)) {
        expect(vars.get(name)?.limit).toBe(Number.POSITIVE_INFINITY);
      }
    });

    test("zero-config controller does not self-brick after repeated tool failures", async () => {
      const controller = createInMemoryController({});
      for (let i = 0; i < 10; i += 1) {
        await controller.record({ kind: "tool_error", toolName: "t" });
      }
      expect((await controller.checkAll()).ok).toBe(true);
    });

    test("setpoints come from config", () => {
      const controller = createInMemoryController({
        tokenUsageLimit: 1000,
        costUsdLimit: 5,
        turnCountLimit: 10,
        spawnDepthLimit: 3,
        spawnCountLimit: 8,
        durationMsLimit: 60_000,
        forgeDepthLimit: 2,
        forgeBudgetLimit: 4,
        errorRateLimit: 0.5,
        contextOccupancyLimit: 0.9,
      });
      const vars = controller.variables();
      expect(vars.get("token_usage")?.limit).toBe(1000);
      expect(vars.get("cost_usd")?.limit).toBe(5);
      expect(vars.get("turn_count")?.limit).toBe(10);
      expect(vars.get("spawn_depth")?.limit).toBe(3);
      expect(vars.get("spawn_count")?.limit).toBe(8);
      expect(vars.get("duration_ms")?.limit).toBe(60_000);
      expect(vars.get("forge_depth")?.limit).toBe(2);
      expect(vars.get("forge_budget")?.limit).toBe(4);
      expect(vars.get("error_rate")?.limit).toBe(0.5);
      expect(vars.get("context_occupancy")?.limit).toBe(0.9);
    });

    test("retryable flag follows governance-core semantics per variable", () => {
      const vars = createInMemoryController({}).variables();
      expect(vars.get(GOVERNANCE_VARIABLES.SPAWN_COUNT)?.retryable).toBe(true);
      expect(vars.get(GOVERNANCE_VARIABLES.ERROR_RATE)?.retryable).toBe(true);
      expect(vars.get(GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY)?.retryable).toBe(true);
      expect(vars.get(GOVERNANCE_VARIABLES.SPAWN_DEPTH)?.retryable).toBe(false);
      expect(vars.get(GOVERNANCE_VARIABLES.TURN_COUNT)?.retryable).toBe(false);
      expect(vars.get(GOVERNANCE_VARIABLES.TOKEN_USAGE)?.retryable).toBe(false);
      expect(vars.get(GOVERNANCE_VARIABLES.COST_USD)?.retryable).toBe(false);
      expect(vars.get(GOVERNANCE_VARIABLES.DURATION_MS)?.retryable).toBe(false);
      expect(vars.get(GOVERNANCE_VARIABLES.FORGE_DEPTH)?.retryable).toBe(false);
      expect(vars.get(GOVERNANCE_VARIABLES.FORGE_BUDGET)?.retryable).toBe(false);
    });
  });

  describe("threshold semantics (>= for bounded counters, > for spawn_depth)", () => {
    test("token_usage fails at the limit, not only above", async () => {
      const controller = createInMemoryController({ tokenUsageLimit: 100 });
      await controller.record({ kind: "token_usage", count: 100 });
      const result = await controller.check("token_usage");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable).toBe(false);
    });

    test("cost_usd fails at the limit, not only above", async () => {
      const controller = createInMemoryController({ costUsdLimit: 1 });
      await controller.record({
        kind: "token_usage",
        count: 0,
        costUsd: 1,
      });
      const result = await controller.check("cost_usd");
      expect(result.ok).toBe(false);
    });

    test("turn_count fails at the limit", async () => {
      const controller = createInMemoryController({ turnCountLimit: 2 });
      await controller.record({ kind: "turn" });
      await controller.record({ kind: "turn" });
      const result = await controller.check("turn_count");
      expect(result.ok).toBe(false);
    });

    test("spawn_count fails at the limit AND is retryable", async () => {
      const controller = createInMemoryController({ spawnCountLimit: 1 });
      await controller.record({ kind: "spawn", depth: 1 });
      const result = await controller.check("spawn_count");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable).toBe(true);
    });

    test("spawn_depth fails only strictly above the limit", async () => {
      const exact = createInMemoryController({ spawnDepthLimit: 3, agentDepth: 3 });
      expect((await exact.check("spawn_depth")).ok).toBe(true);
      const over = createInMemoryController({ spawnDepthLimit: 3, agentDepth: 4 });
      const result = await over.check("spawn_depth");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable).toBe(false);
    });
  });

  describe("record(token_usage)", () => {
    test("accumulates input/output tokens and costUsd", async () => {
      const controller = createInMemoryController({});
      await controller.record({
        kind: "token_usage",
        count: 300,
        inputTokens: 200,
        outputTokens: 100,
        costUsd: 0.002,
      });
      await controller.record({
        kind: "token_usage",
        count: 150,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.001,
      });
      const snap = await controller.snapshot();
      const token = snap.readings.find((r) => r.name === "token_usage");
      const cost = snap.readings.find((r) => r.name === "cost_usd");
      expect(token?.current).toBe(450);
      expect(cost?.current).toBeCloseTo(0.003, 10);
    });

    test("uses count when inputTokens/outputTokens are absent", async () => {
      const controller = createInMemoryController({});
      await controller.record({ kind: "token_usage", count: 777 });
      expect(controller.reading("token_usage")?.current).toBe(777);
    });

    test("rejects NaN costUsd so the spend cap cannot be silently disabled", async () => {
      const controller = createInMemoryController({ costUsdLimit: 10 });
      await controller.record({
        kind: "token_usage",
        count: 10,
        costUsd: Number.NaN,
      });
      expect(controller.reading("cost_usd")?.current).toBe(0);
      expect((await controller.check("cost_usd")).ok).toBe(true);
    });

    test("rejects negative costUsd so later real spend cannot be offset", async () => {
      const controller = createInMemoryController({ costUsdLimit: 10 });
      await controller.record({ kind: "token_usage", count: 10, costUsd: -50 });
      await controller.record({ kind: "token_usage", count: 10, costUsd: 3 });
      expect(controller.reading("cost_usd")?.current).toBeCloseTo(3, 10);
    });

    test("rejects +Infinity costUsd", async () => {
      const controller = createInMemoryController({ costUsdLimit: 10 });
      await controller.record({
        kind: "token_usage",
        count: 10,
        costUsd: Number.POSITIVE_INFINITY,
      });
      expect(controller.reading("cost_usd")?.current).toBe(0);
    });

    test("falls back to per-token pricing when costUsd is omitted (pricing-failure path)", async () => {
      const controller = createInMemoryController({
        fallbackInputUsdPer1M: 3,
        fallbackOutputUsdPer1M: 15,
      });
      // Simulates middleware dropping costUsd because cost.calculate() threw
      // for an unknown model alias.
      await controller.record({
        kind: "token_usage",
        count: 1_500_000,
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      });
      // 1M input * $3/1M + 0.5M output * $15/1M = $3 + $7.5 = $10.5
      expect(controller.reading("cost_usd")?.current).toBeCloseTo(10.5, 10);
    });

    test("fallback pricing not applied when event provides a valid costUsd", async () => {
      const controller = createInMemoryController({
        fallbackInputUsdPer1M: 100,
        fallbackOutputUsdPer1M: 100,
      });
      await controller.record({
        kind: "token_usage",
        count: 1000,
        inputTokens: 500,
        outputTokens: 500,
        costUsd: 0.01,
      });
      expect(controller.reading("cost_usd")?.current).toBeCloseTo(0.01, 10);
    });

    test("fallback pricing not applied when tokens are absent", async () => {
      const controller = createInMemoryController({
        fallbackInputUsdPer1M: 3,
        fallbackOutputUsdPer1M: 15,
      });
      await controller.record({ kind: "token_usage", count: 500 });
      expect(controller.reading("cost_usd")?.current).toBe(0);
    });
  });

  describe("record(turn)", () => {
    test("increments turn_count", async () => {
      const controller = createInMemoryController({ turnCountLimit: 3 });
      await controller.record({ kind: "turn" });
      await controller.record({ kind: "turn" });
      expect(controller.reading("turn_count")?.current).toBe(2);
    });
  });

  describe("record(spawn) / record(spawn_release) — concurrent children semantics", () => {
    test("spawn_count tracks concurrent live children", async () => {
      const controller = createInMemoryController({});
      await controller.record({ kind: "spawn", depth: 1 });
      await controller.record({ kind: "spawn", depth: 2 });
      expect(controller.reading("spawn_count")?.current).toBe(2);

      await controller.record({ kind: "spawn_release" });
      expect(controller.reading("spawn_count")?.current).toBe(1);

      await controller.record({ kind: "spawn_release" });
      expect(controller.reading("spawn_count")?.current).toBe(0);
    });

    test("spawn_release restores capacity so a full controller becomes healthy again", async () => {
      const controller = createInMemoryController({ spawnCountLimit: 1 });
      await controller.record({ kind: "spawn", depth: 1 });
      expect((await controller.check("spawn_count")).ok).toBe(false);
      await controller.record({ kind: "spawn_release" });
      expect((await controller.check("spawn_count")).ok).toBe(true);
    });

    test("spawn_release on an empty counter clamps to zero, not negative", async () => {
      const controller = createInMemoryController({});
      await controller.record({ kind: "spawn_release" });
      expect(controller.reading("spawn_count")?.current).toBe(0);
    });

    test("spawn_depth reflects THIS controller's agentDepth, not child events", async () => {
      const controller = createInMemoryController({ agentDepth: 2 });
      expect(controller.reading("spawn_depth")?.current).toBe(2);
      await controller.record({ kind: "spawn", depth: 99 });
      await controller.record({ kind: "spawn", depth: 7 });
      expect(controller.reading("spawn_depth")?.current).toBe(2);
    });
  });

  describe("record(forge)", () => {
    test("forge_depth and forge_budget both increment per event (shared counter)", async () => {
      const controller = createInMemoryController({});
      await controller.record({ kind: "forge" });
      await controller.record({ kind: "forge", toolName: "build_tool" });
      expect(controller.reading("forge_depth")?.current).toBe(2);
      expect(controller.reading("forge_budget")?.current).toBe(2);
    });
  });

  describe("setContextOccupancy", () => {
    test("updates the sensor reading", () => {
      const controller = createInMemoryController({});
      controller.setContextOccupancy(0.75);
      expect(controller.reading("context_occupancy")?.current).toBe(0.75);
    });

    test("fires the gate when configured limit is reached", async () => {
      const controller = createInMemoryController({ contextOccupancyLimit: 0.9 });
      controller.setContextOccupancy(0.89);
      expect((await controller.check("context_occupancy")).ok).toBe(true);
      controller.setContextOccupancy(0.9);
      const result = await controller.check("context_occupancy");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable).toBe(true);
    });

    test("ignores NaN and negative inputs so the gate cannot be silently disabled", () => {
      const controller = createInMemoryController({});
      controller.setContextOccupancy(0.5);
      controller.setContextOccupancy(Number.NaN);
      controller.setContextOccupancy(-1);
      expect(controller.reading("context_occupancy")?.current).toBe(0.5);
    });
  });

  describe("record(tool_error / tool_success) — rolling error_rate", () => {
    test("error_rate gate waits for the minimum sample size before firing", async () => {
      const controller = createInMemoryController({
        errorRateLimit: 0.5,
        errorRateMinSamples: 3,
      });
      await controller.record({ kind: "tool_error", toolName: "t" });
      await controller.record({ kind: "tool_error", toolName: "t" });
      expect((await controller.check("error_rate")).ok).toBe(true);
      await controller.record({ kind: "tool_error", toolName: "t" });
      const result = await controller.check("error_rate");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable).toBe(true);
    });

    test("error_rate = errors / window when window filled", async () => {
      const controller = createInMemoryController({ errorRateWindow: 4 });
      await controller.record({ kind: "tool_error", toolName: "t" });
      await controller.record({ kind: "tool_success", toolName: "t" });
      await controller.record({ kind: "tool_error", toolName: "t" });
      await controller.record({ kind: "tool_success", toolName: "t" });
      expect(controller.reading("error_rate")?.current).toBeCloseTo(0.5, 10);
    });

    test("window slides — oldest outcome drops off", async () => {
      const controller = createInMemoryController({ errorRateWindow: 3 });
      await controller.record({ kind: "tool_error", toolName: "t" });
      await controller.record({ kind: "tool_error", toolName: "t" });
      await controller.record({ kind: "tool_error", toolName: "t" });
      expect(controller.reading("error_rate")?.current).toBeCloseTo(1, 10);
      await controller.record({ kind: "tool_success", toolName: "t" });
      await controller.record({ kind: "tool_success", toolName: "t" });
      await controller.record({ kind: "tool_success", toolName: "t" });
      expect(controller.reading("error_rate")?.current).toBeCloseTo(0, 10);
    });

    test("error_rate is zero before any tool outcomes", () => {
      const controller = createInMemoryController({});
      expect(controller.reading("error_rate")?.current).toBe(0);
    });
  });

  describe("duration_ms", () => {
    test("reads as now - iteration start", async () => {
      let t = 1_000;
      const controller = createInMemoryController({ now: () => t });
      t = 1_500;
      expect(controller.reading("duration_ms")?.current).toBe(500);
    });

    test("fails at limit and is non-retryable", async () => {
      let t = 0;
      const controller = createInMemoryController({
        durationMsLimit: 500,
        now: () => t,
      });
      t = 500;
      const result = await controller.check("duration_ms");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable).toBe(false);
    });
  });

  describe("checkAll", () => {
    test("returns ok:true when all sensors under limit", async () => {
      const controller = createInMemoryController({ tokenUsageLimit: 1000 });
      await controller.record({ kind: "token_usage", count: 500 });
      const result = await controller.checkAll();
      expect(result).toEqual({ ok: true });
    });

    test("returns first violation", async () => {
      const controller = createInMemoryController({ tokenUsageLimit: 100 });
      await controller.record({ kind: "token_usage", count: 200 });
      const result = await controller.checkAll();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.variable).toBe("token_usage");
      }
    });
  });

  describe("check(variable)", () => {
    test("returns per-variable verdict", async () => {
      const controller = createInMemoryController({ costUsdLimit: 0.001 });
      await controller.record({
        kind: "token_usage",
        count: 10,
        costUsd: 0.002,
      });
      const result = await controller.check("cost_usd");
      expect(result.ok).toBe(false);
    });

    test("returns ok:true for unknown variable names", async () => {
      const controller = createInMemoryController({});
      const result = await controller.check("does-not-exist");
      expect(result.ok).toBe(true);
    });
  });

  describe("snapshot", () => {
    test("sets healthy=false and lists violations when any sensor over limit", async () => {
      const controller = createInMemoryController({
        tokenUsageLimit: 50,
        costUsdLimit: 100,
      });
      await controller.record({ kind: "token_usage", count: 100, costUsd: 1 });
      const snap = await controller.snapshot();
      expect(snap.healthy).toBe(false);
      expect(snap.violations).toContain("token_usage");
      expect(snap.violations).not.toContain("cost_usd");
    });

    test("utilization = current / limit, clamped to 1", async () => {
      const controller = createInMemoryController({ tokenUsageLimit: 1000 });
      await controller.record({ kind: "token_usage", count: 250 });
      const snap = await controller.snapshot();
      const token = snap.readings.find((r) => r.name === "token_usage");
      expect(token?.utilization).toBeCloseTo(0.25, 10);

      await controller.record({ kind: "token_usage", count: 2000 });
      const over = await controller.snapshot();
      const after = over.readings.find((r) => r.name === "token_usage");
      expect(after?.utilization).toBe(1);
    });

    test("utilization is 0 when limit is Infinity", async () => {
      const controller = createInMemoryController({});
      await controller.record({ kind: "token_usage", count: 500 });
      const snap = await controller.snapshot();
      const token = snap.readings.find((r) => r.name === "token_usage");
      expect(token?.utilization).toBe(0);
    });

    test("snapshot and its readings are frozen — callbacks cannot mutate governance state", async () => {
      const controller = createInMemoryController({ tokenUsageLimit: 1000 });
      await controller.record({ kind: "token_usage", count: 100 });
      const snap = await controller.snapshot();
      expect(Object.isFrozen(snap)).toBe(true);
      expect(Object.isFrozen(snap.readings)).toBe(true);
      const first = snap.readings[0];
      expect(first).toBeDefined();
      if (first !== undefined) expect(Object.isFrozen(first)).toBe(true);
    });

    test("reading() return value is frozen", () => {
      const controller = createInMemoryController({ tokenUsageLimit: 1000 });
      const reading = controller.reading("token_usage");
      expect(reading).toBeDefined();
      if (reading !== undefined) expect(Object.isFrozen(reading)).toBe(true);
    });
  });

  describe("iteration_reset semantics (L0 contract)", () => {
    let controller: ReturnType<typeof createInMemoryController>;
    beforeEach(() => {
      let t = 0;
      controller = createInMemoryController({ now: () => t });
      t = 100;
    });

    test("resets turn_count and duration_ms start; preserves token/cost/spawn/error-rate", async () => {
      await controller.record({ kind: "turn" });
      await controller.record({ kind: "turn" });
      await controller.record({
        kind: "token_usage",
        count: 500,
        costUsd: 0.01,
      });
      await controller.record({ kind: "spawn", depth: 2 });
      await controller.record({ kind: "tool_error", toolName: "t" });
      await controller.record({ kind: "tool_error", toolName: "t" });
      await controller.record({ kind: "tool_error", toolName: "t" });

      await controller.record({ kind: "iteration_reset" });

      expect(controller.reading("turn_count")?.current).toBe(0);
      expect(controller.reading("token_usage")?.current).toBe(500);
      expect(controller.reading("cost_usd")?.current).toBeCloseTo(0.01, 10);
      expect(controller.reading("spawn_count")?.current).toBe(1);
      expect(controller.reading("error_rate")?.current).toBeGreaterThan(0);
    });
  });

  describe("session_reset semantics (L0 contract)", () => {
    test("resets turn_count, duration_ms, error_rate; preserves token/cost/spawn", async () => {
      const controller = createInMemoryController({});
      await controller.record({ kind: "turn" });
      await controller.record({ kind: "token_usage", count: 500, costUsd: 0.01 });
      await controller.record({ kind: "spawn", depth: 1 });
      await controller.record({ kind: "tool_error", toolName: "t" });

      await controller.record({ kind: "session_reset" });

      expect(controller.reading("turn_count")?.current).toBe(0);
      expect(controller.reading("error_rate")?.current).toBe(0);
      expect(controller.reading("token_usage")?.current).toBe(500);
      expect(controller.reading("cost_usd")?.current).toBeCloseTo(0.01, 10);
      expect(controller.reading("spawn_count")?.current).toBe(1);
    });
  });
});
