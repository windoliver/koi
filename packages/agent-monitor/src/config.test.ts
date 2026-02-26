/**
 * Unit tests for validateAgentMonitorConfig.
 */

import { describe, expect, test } from "bun:test";
import { validateAgentMonitorConfig } from "./config.js";

describe("validateAgentMonitorConfig", () => {
  test("accepts empty object (all defaults)", () => {
    const result = validateAgentMonitorConfig({});
    expect(result.ok).toBe(true);
  });

  test("rejects null", () => {
    const result = validateAgentMonitorConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects undefined", () => {
    const result = validateAgentMonitorConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects non-object", () => {
    const result = validateAgentMonitorConfig("string");
    expect(result.ok).toBe(false);
  });

  test("accepts valid onAnomaly callback", () => {
    const result = validateAgentMonitorConfig({ onAnomaly: () => {} });
    expect(result.ok).toBe(true);
  });

  test("rejects non-function onAnomaly", () => {
    const result = validateAgentMonitorConfig({ onAnomaly: "not-a-function" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/onAnomaly/);
    }
  });

  test("accepts valid onAnomalyError callback", () => {
    const result = validateAgentMonitorConfig({ onAnomalyError: () => {} });
    expect(result.ok).toBe(true);
  });

  test("rejects non-function onAnomalyError", () => {
    const result = validateAgentMonitorConfig({ onAnomalyError: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/onAnomalyError/);
    }
  });

  test("accepts valid onMetrics callback", () => {
    const result = validateAgentMonitorConfig({ onMetrics: () => {} });
    expect(result.ok).toBe(true);
  });

  test("rejects non-function onMetrics", () => {
    const result = validateAgentMonitorConfig({ onMetrics: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/onMetrics/);
    }
  });

  test("rejects non-object thresholds", () => {
    const result = validateAgentMonitorConfig({ thresholds: "bad" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/thresholds/);
    }
  });

  test("accepts valid thresholds", () => {
    const result = validateAgentMonitorConfig({
      thresholds: {
        maxToolCallsPerTurn: 10,
        maxErrorCallsPerSession: 5,
        maxConsecutiveRepeatCalls: 3,
        maxDeniedCallsPerSession: 2,
        latencyAnomalyFactor: 2,
        minLatencySamples: 3,
        maxDestructiveCallsPerTurn: 2,
        tokenSpikeAnomalyFactor: 3,
        maxDistinctToolsPerTurn: 10,
      },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts valid destructiveToolIds array", () => {
    const result = validateAgentMonitorConfig({
      destructiveToolIds: ["email-delete", "file-rm"],
    });
    expect(result.ok).toBe(true);
  });

  test("accepts empty destructiveToolIds array", () => {
    const result = validateAgentMonitorConfig({ destructiveToolIds: [] });
    expect(result.ok).toBe(true);
  });

  test("rejects non-array destructiveToolIds", () => {
    const result = validateAgentMonitorConfig({ destructiveToolIds: "email-delete" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/destructiveToolIds/);
    }
  });

  test("rejects destructiveToolIds with non-string elements", () => {
    const result = validateAgentMonitorConfig({ destructiveToolIds: [42] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/destructiveToolIds/);
    }
  });

  test("rejects zero maxDestructiveCallsPerTurn", () => {
    const result = validateAgentMonitorConfig({
      thresholds: { maxDestructiveCallsPerTurn: 0 },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects zero maxDistinctToolsPerTurn", () => {
    const result = validateAgentMonitorConfig({
      thresholds: { maxDistinctToolsPerTurn: 0 },
    });
    expect(result.ok).toBe(false);
  });

  test("accepts valid maxPingPongCycles", () => {
    const result = validateAgentMonitorConfig({ thresholds: { maxPingPongCycles: 4 } });
    expect(result.ok).toBe(true);
  });

  test("rejects zero maxPingPongCycles", () => {
    const result = validateAgentMonitorConfig({ thresholds: { maxPingPongCycles: 0 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/maxPingPongCycles/);
    }
  });

  test("accepts valid maxSessionDurationMs", () => {
    const result = validateAgentMonitorConfig({ thresholds: { maxSessionDurationMs: 300_000 } });
    expect(result.ok).toBe(true);
  });

  test("rejects zero maxSessionDurationMs", () => {
    const result = validateAgentMonitorConfig({ thresholds: { maxSessionDurationMs: 0 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/maxSessionDurationMs/);
    }
  });

  test("rejects zero maxToolCallsPerTurn", () => {
    const result = validateAgentMonitorConfig({ thresholds: { maxToolCallsPerTurn: 0 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/maxToolCallsPerTurn/);
    }
  });

  test("rejects negative maxErrorCallsPerSession", () => {
    const result = validateAgentMonitorConfig({
      thresholds: { maxErrorCallsPerSession: -1 },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects non-finite latencyAnomalyFactor", () => {
    const result = validateAgentMonitorConfig({
      thresholds: { latencyAnomalyFactor: Infinity },
    });
    expect(result.ok).toBe(false);
  });

  test("accepts partial thresholds (only some keys)", () => {
    const result = validateAgentMonitorConfig({
      thresholds: { maxToolCallsPerTurn: 5 },
    });
    expect(result.ok).toBe(true);
  });

  // Phase 2: agentDepth

  test("accepts agentDepth = 0 (root agent)", () => {
    const result = validateAgentMonitorConfig({ agentDepth: 0 });
    expect(result.ok).toBe(true);
  });

  test("accepts agentDepth = 3", () => {
    const result = validateAgentMonitorConfig({ agentDepth: 3 });
    expect(result.ok).toBe(true);
  });

  test("rejects negative agentDepth", () => {
    const result = validateAgentMonitorConfig({ agentDepth: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/agentDepth/);
    }
  });

  test("rejects non-integer agentDepth", () => {
    const result = validateAgentMonitorConfig({ agentDepth: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/agentDepth/);
    }
  });

  // Phase 2: spawnToolIds

  test("accepts valid spawnToolIds array", () => {
    const result = validateAgentMonitorConfig({ spawnToolIds: ["forge_agent"] });
    expect(result.ok).toBe(true);
  });

  test("accepts empty spawnToolIds array", () => {
    const result = validateAgentMonitorConfig({ spawnToolIds: [] });
    expect(result.ok).toBe(true);
  });

  test("rejects non-array spawnToolIds", () => {
    const result = validateAgentMonitorConfig({ spawnToolIds: "forge_agent" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/spawnToolIds/);
    }
  });

  test("rejects spawnToolIds with non-string elements", () => {
    const result = validateAgentMonitorConfig({ spawnToolIds: [42] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/spawnToolIds/);
    }
  });

  // Phase 2: maxDelegationDepth threshold

  test("accepts valid maxDelegationDepth", () => {
    const result = validateAgentMonitorConfig({ thresholds: { maxDelegationDepth: 3 } });
    expect(result.ok).toBe(true);
  });

  test("rejects zero maxDelegationDepth", () => {
    const result = validateAgentMonitorConfig({ thresholds: { maxDelegationDepth: 0 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/maxDelegationDepth/);
    }
  });
});
