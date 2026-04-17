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

    test("limits default to Infinity (or 1 for rates) when unspecified", () => {
      const controller = createInMemoryController({});
      const vars = controller.variables();
      expect(vars.get(GOVERNANCE_VARIABLES.TOKEN_USAGE)?.limit).toBe(Number.POSITIVE_INFINITY);
      expect(vars.get(GOVERNANCE_VARIABLES.ERROR_RATE)?.limit).toBe(1);
      expect(vars.get(GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY)?.limit).toBe(1);
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
      const reading = controller.reading("token_usage");
      expect(reading?.current).toBe(777);
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

  describe("record(spawn) / record(spawn_release)", () => {
    test("spawn_depth tracks depth from event; spawn_count is cumulative", async () => {
      const controller = createInMemoryController({});
      await controller.record({ kind: "spawn", depth: 1 });
      await controller.record({ kind: "spawn", depth: 2 });
      expect(controller.reading("spawn_depth")?.current).toBe(2);
      expect(controller.reading("spawn_count")?.current).toBe(2);

      await controller.record({ kind: "spawn_release" });
      expect(controller.reading("spawn_depth")?.current).toBe(1);
      expect(controller.reading("spawn_count")?.current).toBe(2);
    });

    test("spawn_depth never goes below zero", async () => {
      const controller = createInMemoryController({});
      await controller.record({ kind: "spawn_release" });
      expect(controller.reading("spawn_depth")?.current).toBe(0);
    });
  });

  describe("record(forge)", () => {
    test("forge_depth and forge_budget both increment on each forge event", async () => {
      const controller = createInMemoryController({});
      await controller.record({ kind: "forge" });
      await controller.record({ kind: "forge", toolName: "build_tool" });
      expect(controller.reading("forge_depth")?.current).toBe(2);
      expect(controller.reading("forge_budget")?.current).toBe(2);
    });
  });

  describe("record(tool_error / tool_success) — rolling error_rate", () => {
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
  });

  describe("checkAll", () => {
    test("returns ok:true when all sensors under limit", async () => {
      const controller = createInMemoryController({ tokenUsageLimit: 1000 });
      await controller.record({ kind: "token_usage", count: 500 });
      const result = await controller.checkAll();
      expect(result).toEqual({ ok: true });
    });

    test("returns first violation with retryable=false", async () => {
      const controller = createInMemoryController({ tokenUsageLimit: 100 });
      await controller.record({ kind: "token_usage", count: 200 });
      const result = await controller.checkAll();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.variable).toBe("token_usage");
        expect(result.retryable).toBe(false);
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

    test("utilization = current / limit (finite limits only)", async () => {
      const controller = createInMemoryController({ tokenUsageLimit: 1000 });
      await controller.record({ kind: "token_usage", count: 250 });
      const snap = await controller.snapshot();
      const token = snap.readings.find((r) => r.name === "token_usage");
      expect(token?.utilization).toBeCloseTo(0.25, 10);
    });

    test("utilization is 0 when limit is Infinity", async () => {
      const controller = createInMemoryController({});
      await controller.record({ kind: "token_usage", count: 500 });
      const snap = await controller.snapshot();
      const token = snap.readings.find((r) => r.name === "token_usage");
      expect(token?.utilization).toBe(0);
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

      await controller.record({ kind: "iteration_reset" });

      expect(controller.reading("turn_count")?.current).toBe(0);
      expect(controller.reading("token_usage")?.current).toBe(500);
      expect(controller.reading("cost_usd")?.current).toBeCloseTo(0.01, 10);
      expect(controller.reading("spawn_depth")?.current).toBe(2);
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
      expect(controller.reading("spawn_depth")?.current).toBe(1);
    });
  });
});
