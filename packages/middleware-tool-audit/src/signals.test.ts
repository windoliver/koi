import { describe, expect, test } from "bun:test";
import type { ToolAuditConfig } from "./config.js";
import { computeLifecycleSignals } from "./signals.js";
import type { ToolAuditSnapshot, ToolUsageRecord } from "./types.js";

function createRecord(
  overrides: Partial<ToolUsageRecord> & { readonly toolName: string },
): ToolUsageRecord {
  return {
    callCount: 0,
    successCount: 0,
    failureCount: 0,
    lastUsedAt: 0,
    avgLatencyMs: 0,
    minLatencyMs: 0,
    maxLatencyMs: 0,
    totalLatencyMs: 0,
    sessionsAvailable: 0,
    sessionsUsed: 0,
    ...overrides,
  };
}

function createSnapshot(tools: readonly ToolUsageRecord[], totalSessions = 100): ToolAuditSnapshot {
  const toolsRecord: Record<string, ToolUsageRecord> = {};
  for (const tool of tools) {
    toolsRecord[tool.toolName] = tool;
  }
  return { tools: toolsRecord, totalSessions, lastUpdatedAt: Date.now() };
}

const defaultConfig: ToolAuditConfig = {};

describe("computeLifecycleSignals", () => {
  describe("unused signal", () => {
    test("fires when 0 calls and >= threshold sessions", () => {
      const snapshot = createSnapshot([
        createRecord({ toolName: "search", callCount: 0, sessionsAvailable: 50 }),
      ]);

      const results = computeLifecycleSignals(snapshot, defaultConfig);
      const unused = results.filter((r) => r.signal === "unused");

      expect(unused.length).toBe(1);
      expect(unused[0]?.toolName).toBe("search");
      expect(unused[0]?.details).toContain("never been called");
    });

    test("does not fire when 0 calls but < threshold sessions (insufficient data)", () => {
      const snapshot = createSnapshot([
        createRecord({ toolName: "search", callCount: 0, sessionsAvailable: 10 }),
      ]);

      const results = computeLifecycleSignals(snapshot, defaultConfig);
      const unused = results.filter((r) => r.signal === "unused");

      expect(unused.length).toBe(0);
    });

    test("does not fire when tool has calls", () => {
      const snapshot = createSnapshot([
        createRecord({ toolName: "search", callCount: 1, successCount: 1, sessionsAvailable: 100 }),
      ]);

      const results = computeLifecycleSignals(snapshot, defaultConfig);
      const unused = results.filter((r) => r.signal === "unused");

      expect(unused.length).toBe(0);
    });
  });

  describe("low_adoption signal", () => {
    test("fires when < 5% adoption and >= min sessions", () => {
      const snapshot = createSnapshot([
        createRecord({
          toolName: "search",
          callCount: 1,
          successCount: 1,
          sessionsAvailable: 100,
          sessionsUsed: 2, // 2% adoption
        }),
      ]);

      const results = computeLifecycleSignals(snapshot, defaultConfig);
      const lowAdoption = results.filter((r) => r.signal === "low_adoption");

      expect(lowAdoption.length).toBe(1);
      expect(lowAdoption[0]?.toolName).toBe("search");
    });

    test("does not fire when < min sessions", () => {
      const snapshot = createSnapshot([
        createRecord({
          toolName: "search",
          callCount: 1,
          successCount: 1,
          sessionsAvailable: 5, // below default minSessionsForAdoption (10)
          sessionsUsed: 0,
        }),
      ]);

      const results = computeLifecycleSignals(snapshot, defaultConfig);
      const lowAdoption = results.filter((r) => r.signal === "low_adoption");

      expect(lowAdoption.length).toBe(0);
    });

    test("does not fire when adoption is above threshold", () => {
      const snapshot = createSnapshot([
        createRecord({
          toolName: "search",
          callCount: 10,
          successCount: 10,
          sessionsAvailable: 100,
          sessionsUsed: 50, // 50% adoption — well above 5%
        }),
      ]);

      const results = computeLifecycleSignals(snapshot, defaultConfig);
      const lowAdoption = results.filter((r) => r.signal === "low_adoption");

      expect(lowAdoption.length).toBe(0);
    });
  });

  describe("high_failure signal", () => {
    test("fires when > 50% failure and >= min calls", () => {
      const snapshot = createSnapshot([
        createRecord({
          toolName: "search",
          callCount: 10,
          successCount: 3,
          failureCount: 7, // 70% failure
        }),
      ]);

      const results = computeLifecycleSignals(snapshot, defaultConfig);
      const highFailure = results.filter((r) => r.signal === "high_failure");

      expect(highFailure.length).toBe(1);
      expect(highFailure[0]?.toolName).toBe("search");
    });

    test("does not fire when 100% failure but < min calls", () => {
      const snapshot = createSnapshot([
        createRecord({
          toolName: "search",
          callCount: 3, // below default minCallsForFailure (5)
          successCount: 0,
          failureCount: 3,
        }),
      ]);

      const results = computeLifecycleSignals(snapshot, defaultConfig);
      const highFailure = results.filter((r) => r.signal === "high_failure");

      expect(highFailure.length).toBe(0);
    });

    test("does not fire when failure rate is below threshold", () => {
      const snapshot = createSnapshot([
        createRecord({
          toolName: "search",
          callCount: 10,
          successCount: 6,
          failureCount: 4, // 40% failure — below 50% threshold
        }),
      ]);

      const results = computeLifecycleSignals(snapshot, defaultConfig);
      const highFailure = results.filter((r) => r.signal === "high_failure");

      expect(highFailure.length).toBe(0);
    });
  });

  describe("high_value signal", () => {
    test("fires when >= 90% success and >= min calls", () => {
      const snapshot = createSnapshot([
        createRecord({
          toolName: "search",
          callCount: 20,
          successCount: 19,
          failureCount: 1, // 95% success
        }),
      ]);

      const results = computeLifecycleSignals(snapshot, defaultConfig);
      const highValue = results.filter((r) => r.signal === "high_value");

      expect(highValue.length).toBe(1);
      expect(highValue[0]?.toolName).toBe("search");
    });

    test("does not fire when 95% success but < min calls", () => {
      const snapshot = createSnapshot([
        createRecord({
          toolName: "search",
          callCount: 3, // below default highValueMinCalls (20)
          successCount: 3,
          failureCount: 0,
        }),
      ]);

      const results = computeLifecycleSignals(snapshot, defaultConfig);
      const highValue = results.filter((r) => r.signal === "high_value");

      expect(highValue.length).toBe(0);
    });

    test("does not fire when success rate is below threshold", () => {
      const snapshot = createSnapshot([
        createRecord({
          toolName: "search",
          callCount: 20,
          successCount: 15,
          failureCount: 5, // 75% success — below 90%
        }),
      ]);

      const results = computeLifecycleSignals(snapshot, defaultConfig);
      const highValue = results.filter((r) => r.signal === "high_value");

      expect(highValue.length).toBe(0);
    });
  });

  describe("multi-signal and edge cases", () => {
    test("multiple signals on same tool (high failure + low adoption)", () => {
      const snapshot = createSnapshot([
        createRecord({
          toolName: "broken-tool",
          callCount: 10,
          successCount: 2,
          failureCount: 8, // 80% failure
          sessionsAvailable: 100,
          sessionsUsed: 3, // 3% adoption
        }),
      ]);

      const results = computeLifecycleSignals(snapshot, defaultConfig);
      const toolSignals = results.filter((r) => r.toolName === "broken-tool");

      expect(toolSignals.length).toBe(2);
      const signalKinds = toolSignals.map((r) => r.signal);
      expect(signalKinds).toContain("high_failure");
      expect(signalKinds).toContain("low_adoption");
    });

    test("confidence scales with sample size", () => {
      const snapshot = createSnapshot([
        createRecord({
          toolName: "search",
          callCount: 0,
          sessionsAvailable: 50, // exactly at threshold
        }),
      ]);

      const results = computeLifecycleSignals(snapshot, defaultConfig);
      const unused = results.find((r) => r.signal === "unused");

      expect(unused).toBeDefined();
      // confidence = min(1, 50 / (50 * 2)) = 0.5
      expect(unused?.confidence).toBe(0.5);
    });

    test("confidence caps at 1.0 for large sample sizes", () => {
      const snapshot = createSnapshot([
        createRecord({
          toolName: "search",
          callCount: 0,
          sessionsAvailable: 200, // 4x threshold
        }),
      ]);

      const results = computeLifecycleSignals(snapshot, defaultConfig);
      const unused = results.find((r) => r.signal === "unused");

      expect(unused?.confidence).toBe(1);
    });

    test("empty snapshot returns empty results", () => {
      const snapshot = createSnapshot([]);
      const results = computeLifecycleSignals(snapshot, defaultConfig);

      expect(results.length).toBe(0);
    });

    test("custom thresholds override defaults", () => {
      const snapshot = createSnapshot([
        createRecord({
          toolName: "search",
          callCount: 0,
          sessionsAvailable: 5,
        }),
      ]);

      // Lower the threshold so 5 sessions triggers unused
      const customConfig: ToolAuditConfig = { unusedThresholdSessions: 3 };
      const results = computeLifecycleSignals(snapshot, customConfig);
      const unused = results.filter((r) => r.signal === "unused");

      expect(unused.length).toBe(1);
    });
  });
});
