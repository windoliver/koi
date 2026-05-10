import { describe, expect, test } from "bun:test";
import { type SystemSignal, taskId } from "@koi/core";
import { mapSystemSignalToCompositionTrigger } from "./composition-trigger.js";

describe("mapSystemSignalToCompositionTrigger", () => {
  test("maps governance threshold crossings", () => {
    const signal = {
      kind: "governance",
      sensor: "error_rate",
      value: 0.4,
      limit: 0.2,
      direction: "above",
      emittedAt: 123,
    } as const satisfies SystemSignal;

    expect(mapSystemSignalToCompositionTrigger(signal)).toEqual({
      id: "governance:error_rate:above:0.2:123",
      source: "governance",
      confidence: 1,
      moment: {
        kind: "threshold_crossed",
        sensor: "error_rate",
        value: 0.4,
        limit: 0.2,
        direction: "above",
      },
      suggestedCapabilities: ["spawn_agent", "notify_user"],
      context: {},
      emittedAt: 123,
    });
  });

  test("two thresholds on same sensor at same emittedAt produce distinct trigger IDs", () => {
    const warning = {
      kind: "governance",
      sensor: "error_rate",
      value: 0.4,
      limit: 0.3,
      direction: "above",
      emittedAt: 200,
    } as const satisfies SystemSignal;
    const critical = {
      kind: "governance",
      sensor: "error_rate",
      value: 0.4,
      limit: 0.6,
      direction: "above",
      emittedAt: 200,
    } as const satisfies SystemSignal;
    const reverse = {
      kind: "governance",
      sensor: "error_rate",
      value: 0.4,
      limit: 0.3,
      direction: "below",
      emittedAt: 200,
    } as const satisfies SystemSignal;

    const idA = mapSystemSignalToCompositionTrigger(warning)?.id;
    const idB = mapSystemSignalToCompositionTrigger(critical)?.id;
    const idC = mapSystemSignalToCompositionTrigger(reverse)?.id;
    expect(idA).not.toBe(idB);
    expect(idA).not.toBe(idC);
    expect(idB).not.toBe(idC);
  });

  test("maps governance threshold crossings without special suggestions", () => {
    const signal = {
      kind: "governance",
      sensor: "cpu_usage",
      value: 0.9,
      limit: 0.8,
      direction: "above",
      emittedAt: 124,
    } as const satisfies SystemSignal;

    expect(mapSystemSignalToCompositionTrigger(signal)).toMatchObject({
      id: "governance:cpu_usage:above:0.8:124",
      suggestedCapabilities: [],
      context: {},
    });
  });

  test("maps forge demand to capability_gap", () => {
    const signal = {
      id: "fd-1",
      kind: "forge_demand",
      confidence: 0.7,
      suggestedBrickKind: "agent",
      trigger: { kind: "capability_gap", requiredCapability: "diagnostics" },
      context: { failureCount: 2, failedToolCalls: [] },
      emittedAt: 50,
    } as const satisfies SystemSignal;

    expect(mapSystemSignalToCompositionTrigger(signal)).toEqual({
      id: "fd-1",
      source: "forge_demand",
      confidence: 0.7,
      moment: { kind: "capability_gap", missing: "diagnostics" },
      suggestedCapabilities: ["forge_agent"],
      context: { forgeDemand: signal },
      emittedAt: 50,
    });
  });

  test("maps other forge demand triggers to the most specific missing capability", () => {
    const cases = [
      {
        trigger: { kind: "composition_gap", requiredCapability: "reporting", observedCount: 2 },
        missing: "reporting",
      },
      {
        trigger: { kind: "agent_capability_gap", agentType: "researcher" },
        missing: "researcher",
      },
      {
        trigger: {
          kind: "agent_repeated_failure",
          agentType: "builder",
          brickId: "brick-1" as never,
          errorRate: 0.7,
        },
        missing: "builder",
      },
      {
        trigger: {
          kind: "agent_latency_degradation",
          agentType: "planner",
          brickId: "brick-2" as never,
          p95Ms: 2500,
        },
        missing: "planner",
      },
      {
        trigger: { kind: "data_source_gap", sourceName: "jira", missingCapability: "tickets" },
        missing: "tickets",
      },
      {
        trigger: { kind: "data_source_detected", sourceName: "calendar", protocol: "ics" },
        missing: "calendar",
      },
      {
        trigger: { kind: "repeated_failure", toolName: "search", count: 3 },
        missing: "search",
      },
      {
        trigger: {
          kind: "performance_degradation",
          toolName: "fetch",
          metric: "latency",
        },
        missing: "fetch",
      },
      {
        trigger: { kind: "no_matching_tool", query: "sync contacts", attempts: 2 },
        missing: "sync contacts",
      },
      {
        trigger: {
          kind: "complex_task_completed",
          toolCallCount: 6,
          taskDescription: "prepare release notes",
          toolsUsed: ["edit", "search"],
          turnCount: 4,
        },
        missing: "prepare release notes",
      },
      {
        trigger: {
          kind: "user_correction",
          correctionText: "use the draft API",
          correctedToolCall: "createDraft",
          correctionDescription: "wrong tool call",
        },
        missing: "createDraft",
      },
      {
        trigger: {
          kind: "novel_workflow",
          workflowDescription: "triage inbound issues",
          toolSequence: ["search", "summarize"],
        },
        missing: "triage inbound issues",
      },
    ] as const;

    for (const { trigger, missing } of cases) {
      const signal = {
        id: `fd-${trigger.kind}`,
        kind: "forge_demand",
        confidence: 0.5,
        suggestedBrickKind: "skill",
        trigger,
        context: { failureCount: 1, failedToolCalls: [] },
        emittedAt: 51,
      } as const satisfies SystemSignal;

      expect(mapSystemSignalToCompositionTrigger(signal)?.moment).toEqual({
        kind: "capability_gap",
        missing,
      });
    }
  });

  test("maps schedule terminal failure to task_terminal", () => {
    const signal = {
      kind: "schedule",
      event: {
        kind: "task:failed",
        taskId: taskId("task-1"),
        error: { message: "boom" } as never,
      },
      emittedAt: 77,
    } as const satisfies SystemSignal;

    expect(mapSystemSignalToCompositionTrigger(signal)).toEqual({
      id: "schedule:task-1:77",
      source: "schedule",
      confidence: 1,
      moment: {
        kind: "task_terminal",
        taskId: taskId("task-1"),
        outcome: "failed",
      },
      suggestedCapabilities: ["spawn_agent", "notify_user"],
      context: { schedulerEvent: signal.event },
      emittedAt: 77,
    });
  });

  test("maps other terminal schedule outcomes", () => {
    const cases = [
      {
        event: {
          kind: "task:completed",
          taskId: taskId("task-completed"),
          result: { ok: true },
        },
        outcome: "completed" as const,
        suggestions: [],
      },
      {
        event: {
          kind: "task:dead_letter",
          taskId: taskId("task-dead-letter"),
          error: { message: "dlq" } as never,
        },
        outcome: "dead_letter" as const,
        suggestions: ["spawn_agent", "notify_user"],
      },
      {
        event: {
          kind: "task:cancelled",
          taskId: taskId("task-cancelled"),
        },
        outcome: "cancelled" as const,
        suggestions: [],
      },
    ] as const;

    for (const { event, outcome, suggestions } of cases) {
      const signal = {
        kind: "schedule",
        event,
        emittedAt: 88,
      } as const satisfies SystemSignal;

      const trigger = mapSystemSignalToCompositionTrigger(signal);
      expect(trigger?.moment).toEqual({
        kind: "task_terminal",
        taskId: event.taskId,
        outcome,
      });
      expect(trigger?.suggestedCapabilities).toEqual(suggestions);
    }
  });

  test("keeps cancelled schedule events terminal without noisy follow-up suggestions", () => {
    const signal = {
      kind: "schedule",
      event: {
        kind: "task:cancelled",
        taskId: taskId("task-cancelled"),
      },
      emittedAt: 89,
    } as const satisfies SystemSignal;

    expect(mapSystemSignalToCompositionTrigger(signal)).toEqual({
      id: "schedule:task-cancelled:89",
      source: "schedule",
      confidence: 1,
      moment: {
        kind: "task_terminal",
        taskId: taskId("task-cancelled"),
        outcome: "cancelled",
      },
      suggestedCapabilities: [],
      context: { schedulerEvent: signal.event },
      emittedAt: 89,
    });
  });

  test("maps metric anomalies to frontier_changed", () => {
    const signal = {
      kind: "anomaly",
      anomaly: {
        kind: "model_latency_anomaly",
        sessionId: "session-1" as never,
        agentId: "agent-1" as never,
        timestamp: 90,
        turnIndex: 4,
        latencyMs: 1800,
        mean: 600,
        stddev: 100,
        factor: 12,
      },
    } as const satisfies SystemSignal;

    expect(mapSystemSignalToCompositionTrigger(signal)).toEqual({
      id: "anomaly:agent-1:model_latency_anomaly:90",
      source: "anomaly",
      confidence: 1,
      moment: {
        kind: "frontier_changed",
        metric: "model_latency_ms",
        improvement: -1200,
      },
      suggestedCapabilities: ["spawn_agent"],
      context: { anomaly: signal.anomaly },
      emittedAt: 90,
    });
  });

  test("ignores synthetic goal-drift sentinels", () => {
    const signal = {
      kind: "anomaly",
      anomaly: {
        kind: "goal_drift",
        sessionId: "session-1" as never,
        agentId: "agent-3" as never,
        timestamp: 92,
        turnIndex: 6,
        driftScore: -1,
        threshold: 0.6,
        objectives: ["triage issues"],
      },
    } as const satisfies SystemSignal;

    expect(mapSystemSignalToCompositionTrigger(signal)).toBeUndefined();
  });

  test("ignores non-metric anomalies in the first pass", () => {
    const signal = {
      kind: "anomaly",
      anomaly: {
        kind: "tool_ping_pong",
        sessionId: "session-1" as never,
        agentId: "agent-2" as never,
        timestamp: 91,
        turnIndex: 5,
        toolIdA: "search",
        toolIdB: "summarize",
        altCount: 8,
        threshold: 4,
      },
    } as const satisfies SystemSignal;

    expect(mapSystemSignalToCompositionTrigger(signal)).toBeUndefined();
  });

  test("ignores agent lifecycle in the first pass", () => {
    const signal = {
      kind: "agent_lifecycle",
      agentId: "a-1" as never,
      from: "created" as never,
      to: "running" as never,
      reason: "started" as never,
      generation: 1,
      emittedAt: 10,
    } as const satisfies SystemSignal;

    expect(mapSystemSignalToCompositionTrigger(signal)).toBeUndefined();
  });
});
