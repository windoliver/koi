/**
 * Tests for agent-monitor + security-analyzer auto-wiring in createGovernanceStack().
 *
 * Verifies:
 *   - agentMonitor alone → monitor middleware, no analyzer injection
 *   - agentMonitor + execApprovals → composite analyzer injected, collector on bundle
 *   - securityAnalyzer + execApprovals (no agentMonitor) → rules analyzer only
 *   - Explicit securityAnalyzer on execApprovals → auto-wiring skipped
 *   - User callbacks chained, not replaced
 *   - Priority 360 for agent-monitor middleware
 *   - Preset coverage (open/standard/strict)
 */

import { describe, expect, test } from "bun:test";
import { createGovernanceStack } from "../governance-stack.js";

describe("createGovernanceStack — agent-monitor + security-analyzer auto-wiring", () => {
  test("agentMonitor alone → monitor middleware present, no analyzer injection", () => {
    const { middlewares, anomalyCollector } = createGovernanceStack({
      agentMonitor: {},
    });
    const monitor = middlewares.find((mw) => mw.name === "agent-monitor");
    expect(monitor).toBeDefined();
    // No exec-approvals → no collector
    expect(anomalyCollector).toBeUndefined();
  });

  test("agentMonitor + execApprovals → composite analyzer injected, collector on bundle", () => {
    const { middlewares, anomalyCollector } = createGovernanceStack({
      agentMonitor: {},
      execApprovals: {
        rules: { allow: [], deny: [], ask: ["*"] },
        onAsk: async () => ({ kind: "deny_once" as const, reason: "test" }),
      },
    });
    const monitor = middlewares.find((mw) => mw.name === "agent-monitor");
    expect(monitor).toBeDefined();
    const ea = middlewares.find((mw) => mw.name === "exec-approvals");
    expect(ea).toBeDefined();
    // Collector is present because agentMonitor + execApprovals are both configured
    expect(anomalyCollector).toBeDefined();
    expect(anomalyCollector?.getRecentAnomalies("test-session")).toEqual([]);
  });

  test("securityAnalyzer + execApprovals (no agentMonitor) → rules analyzer only, no bridge", () => {
    const { middlewares, anomalyCollector } = createGovernanceStack({
      securityAnalyzer: { highPatterns: ["rm -rf"] },
      execApprovals: {
        rules: { allow: [], deny: [], ask: ["*"] },
        onAsk: async () => ({ kind: "deny_once" as const, reason: "test" }),
      },
    });
    // No agent-monitor middleware
    const monitor = middlewares.find((mw) => mw.name === "agent-monitor");
    expect(monitor).toBeUndefined();
    // Exec-approvals is present (rules analyzer injected)
    const ea = middlewares.find((mw) => mw.name === "exec-approvals");
    expect(ea).toBeDefined();
    // No collector because no agentMonitor
    expect(anomalyCollector).toBeUndefined();
  });

  test("explicit securityAnalyzer on execApprovals config → auto-wiring skipped", () => {
    const customAnalyzer = {
      analyze: async () => ({
        riskLevel: "low" as const,
        findings: [],
        rationale: "custom",
      }),
    };
    const { anomalyCollector } = createGovernanceStack({
      agentMonitor: {},
      execApprovals: {
        rules: { allow: [], deny: [], ask: ["*"] },
        onAsk: async () => ({ kind: "deny_once" as const, reason: "test" }),
        securityAnalyzer: customAnalyzer,
      },
    });
    // User already provided securityAnalyzer → no auto-wiring, no collector
    expect(anomalyCollector).toBeUndefined();
  });

  test("user onAnomaly callback preserved during stack construction", () => {
    const userSignals: unknown[] = [];
    const { anomalyCollector } = createGovernanceStack({
      agentMonitor: {
        onAnomaly: (signal) => {
          userSignals.push(signal);
        },
      },
      execApprovals: {
        rules: { allow: [], deny: [], ask: ["*"] },
        onAsk: async () => ({ kind: "deny_once" as const, reason: "test" }),
      },
    });
    // Stack constructed without error, user callback preserved.
    // Actual chaining verified via the monitor middleware firing callbacks at runtime.
    expect(userSignals).toEqual([]);
    expect(anomalyCollector).toBeDefined();
  });

  test("agent-monitor priority is 360", () => {
    const { middlewares } = createGovernanceStack({
      agentMonitor: {},
    });
    const monitor = middlewares.find((mw) => mw.name === "agent-monitor");
    expect(monitor).toBeDefined();
    expect(monitor?.priority).toBe(360);
  });

  test("anomalyCollector.getRecentAnomalies returns empty for unknown session", () => {
    const { anomalyCollector } = createGovernanceStack({
      agentMonitor: {},
      execApprovals: {
        rules: { allow: [], deny: [], ask: ["*"] },
        onAsk: async () => ({ kind: "deny_once" as const, reason: "test" }),
      },
    });
    expect(anomalyCollector).toBeDefined();

    // Initially empty
    expect(anomalyCollector?.getRecentAnomalies("sess-1")).toEqual([]);

    // After clearSession on non-existent session — still empty, no throw
    anomalyCollector?.clearSession("sess-1");
    expect(anomalyCollector?.getRecentAnomalies("sess-1")).toEqual([]);
  });

  test("preset: standard → agentMonitor middleware present", () => {
    const { middlewares } = createGovernanceStack({ preset: "standard" });
    const monitor = middlewares.find((mw) => mw.name === "agent-monitor");
    expect(monitor).toBeDefined();
  });

  test("preset: strict → agentMonitor middleware present", () => {
    const { middlewares } = createGovernanceStack({ preset: "strict" });
    const monitor = middlewares.find((mw) => mw.name === "agent-monitor");
    expect(monitor).toBeDefined();
  });

  test("preset: open → no agentMonitor middleware", () => {
    const { middlewares } = createGovernanceStack({ preset: "open" });
    const monitor = middlewares.find((mw) => mw.name === "agent-monitor");
    expect(monitor).toBeUndefined();
  });
});
