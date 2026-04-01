import { describe, expect, test } from "bun:test";
import type { SecurityAnalyzer } from "@koi/core";
import type { AnomalySignalLike, MonitorBridgeConfig } from "./monitor-bridge.js";
import { createMonitorBridgeAnalyzer } from "./monitor-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWrapped(riskLevel: "low" | "medium" | "high" | "critical"): SecurityAnalyzer {
  return {
    analyze: async () => ({
      riskLevel,
      findings: [],
      rationale: `base: ${riskLevel}`,
    }),
  };
}

const NO_ANOMALIES: readonly AnomalySignalLike[] = [];

function makeAnomaly(kind: string, sessionId = "sess-1"): AnomalySignalLike {
  return { kind, sessionId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMonitorBridgeAnalyzer", () => {
  test("no anomalies → delegates to wrapped unchanged", async () => {
    const bridge = createMonitorBridgeAnalyzer({
      wrapped: makeWrapped("medium"),
      getRecentAnomalies: () => NO_ANOMALIES,
    });

    const result = await bridge.analyze("bash", { command: "curl x.com" }, { sessionId: "sess-1" });
    expect(result.riskLevel).toBe("medium");
    expect(result.findings).toHaveLength(0);
    expect(result.rationale).toBe("base: medium");
  });

  test("anomalies present → elevates to at least 'high'", async () => {
    const bridge = createMonitorBridgeAnalyzer({
      wrapped: makeWrapped("low"),
      getRecentAnomalies: () => [makeAnomaly("tool_rate_exceeded")],
    });

    const result = await bridge.analyze("bash", { command: "ls" }, { sessionId: "sess-1" });
    expect(result.riskLevel).toBe("high");
    expect(result.findings.some((f) => f.pattern === "monitor:anomaly")).toBe(true);
  });

  test("anomalies present with base 'critical' → stays 'critical'", async () => {
    const bridge = createMonitorBridgeAnalyzer({
      wrapped: makeWrapped("critical"),
      getRecentAnomalies: () => [makeAnomaly("error_spike")],
    });

    const result = await bridge.analyze("bash", { command: "rm -rf /" }, { sessionId: "sess-1" });
    expect(result.riskLevel).toBe("critical");
  });

  test("anomalies present with base 'high' → stays 'high'", async () => {
    const bridge = createMonitorBridgeAnalyzer({
      wrapped: makeWrapped("high"),
      getRecentAnomalies: () => [makeAnomaly("error_spike")],
    });

    const result = await bridge.analyze("bash", { command: "sudo ls" }, { sessionId: "sess-1" });
    expect(result.riskLevel).toBe("high");
  });

  test("callback throws → fail-open, returns base analysis unchanged", async () => {
    const bridge = createMonitorBridgeAnalyzer({
      wrapped: makeWrapped("medium"),
      getRecentAnomalies: () => {
        throw new Error("monitor unavailable");
      },
    });

    const result = await bridge.analyze("bash", { command: "curl" }, { sessionId: "sess-1" });
    expect(result.riskLevel).toBe("medium");
    expect(result.rationale).toBe("base: medium");
  });

  test("no sessionId in context → delegates to wrapped unchanged", async () => {
    const bridge = createMonitorBridgeAnalyzer({
      wrapped: makeWrapped("medium"),
      getRecentAnomalies: () => [makeAnomaly("error_spike")],
    });

    // No context
    const resultNoCtx = await bridge.analyze("bash", { command: "curl" });
    expect(resultNoCtx.riskLevel).toBe("medium");

    // Empty context (no sessionId)
    const resultEmptyCtx = await bridge.analyze("bash", { command: "curl" }, {});
    expect(resultEmptyCtx.riskLevel).toBe("medium");
  });

  test("elevateOnAnomalyKinds filters which anomaly kinds trigger elevation", async () => {
    const config: MonitorBridgeConfig = {
      wrapped: makeWrapped("low"),
      getRecentAnomalies: () => [
        makeAnomaly("error_spike"), // not in elevate list
        makeAnomaly("goal_drift"), // not in elevate list
      ],
      elevateOnAnomalyKinds: ["tool_rate_exceeded", "denied_tool_calls"],
    };
    const bridge = createMonitorBridgeAnalyzer(config);

    // Anomalies are present but none are in the elevate list → no elevation
    const result = await bridge.analyze("bash", { command: "ls" }, { sessionId: "sess-1" });
    expect(result.riskLevel).toBe("low");
    expect(result.findings.some((f) => f.pattern === "monitor:anomaly")).toBe(false);
  });

  test("elevateOnAnomalyKinds triggers elevation when matching kind present", async () => {
    const config: MonitorBridgeConfig = {
      wrapped: makeWrapped("low"),
      getRecentAnomalies: () => [makeAnomaly("tool_rate_exceeded")],
      elevateOnAnomalyKinds: ["tool_rate_exceeded"],
    };
    const bridge = createMonitorBridgeAnalyzer(config);

    const result = await bridge.analyze("bash", { command: "ls" }, { sessionId: "sess-1" });
    expect(result.riskLevel).toBe("high");
  });

  test("rationale includes anomaly count", async () => {
    const bridge = createMonitorBridgeAnalyzer({
      wrapped: makeWrapped("low"),
      getRecentAnomalies: () => [makeAnomaly("error_spike"), makeAnomaly("tool_rate_exceeded")],
    });

    const result = await bridge.analyze("bash", { command: "ls" }, { sessionId: "sess-1" });
    expect(result.rationale).toContain("2 anomaly signal(s)");
  });

  test("anomaly finding includes count in description", async () => {
    const bridge = createMonitorBridgeAnalyzer({
      wrapped: makeWrapped("low"),
      getRecentAnomalies: () => [makeAnomaly("error_spike"), makeAnomaly("tool_rate_exceeded")],
    });

    const result = await bridge.analyze("bash", { command: "ls" }, { sessionId: "sess-1" });
    const anomalyFinding = result.findings.find((f) => f.pattern === "monitor:anomaly");
    expect(anomalyFinding?.description).toContain("2");
  });
});
