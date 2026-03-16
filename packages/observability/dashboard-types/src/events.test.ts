import { describe, expect, test } from "bun:test";
import type { AgentId } from "@koi/core";
import type { DashboardEvent } from "./events.js";
import {
  isAgentEvent,
  isChannelEvent,
  isDashboardEvent,
  isForgeEvent,
  isMonitorEvent,
  isSkillEvent,
  isSystemEvent,
} from "./events.js";

const AGENT_ID = "agent-1" as AgentId;

describe("isDashboardEvent", () => {
  test("returns true for valid agent event", () => {
    const event: DashboardEvent = {
      kind: "agent",
      subKind: "status_changed",
      agentId: AGENT_ID,
      from: "created",
      to: "running",
      timestamp: Date.now(),
    };
    expect(isDashboardEvent(event)).toBe(true);
  });

  test("returns true for valid system event", () => {
    const event: DashboardEvent = {
      kind: "system",
      subKind: "activity",
      message: "test",
      timestamp: Date.now(),
    };
    expect(isDashboardEvent(event)).toBe(true);
  });

  test("returns false for null", () => {
    expect(isDashboardEvent(null)).toBe(false);
  });

  test("returns false for non-object", () => {
    expect(isDashboardEvent("string")).toBe(false);
    expect(isDashboardEvent(42)).toBe(false);
  });

  test("returns false for object without kind", () => {
    expect(isDashboardEvent({ subKind: "test", timestamp: 1 })).toBe(false);
  });

  test("returns false for object with invalid kind", () => {
    expect(isDashboardEvent({ kind: "invalid", subKind: "test", timestamp: 1 })).toBe(false);
  });

  test("returns false for object without timestamp", () => {
    expect(isDashboardEvent({ kind: "agent", subKind: "test" })).toBe(false);
  });

  test("returns false for object without subKind", () => {
    expect(isDashboardEvent({ kind: "agent", timestamp: 1 })).toBe(false);
  });
});

describe("isAgentEvent", () => {
  test("returns true for agent event", () => {
    const event: DashboardEvent = {
      kind: "agent",
      subKind: "dispatched",
      agentId: AGENT_ID,
      name: "test-agent",
      agentType: "copilot",
      timestamp: Date.now(),
    };
    expect(isAgentEvent(event)).toBe(true);
  });

  test("returns false for non-agent event", () => {
    const event: DashboardEvent = {
      kind: "system",
      subKind: "activity",
      message: "test",
      timestamp: Date.now(),
    };
    expect(isAgentEvent(event)).toBe(false);
  });
});

describe("isSkillEvent", () => {
  test("returns true for skill event", () => {
    const event: DashboardEvent = {
      kind: "skill",
      subKind: "installed",
      name: "my-skill",
      timestamp: Date.now(),
    };
    expect(isSkillEvent(event)).toBe(true);
  });

  test("returns false for non-skill event", () => {
    const event: DashboardEvent = {
      kind: "agent",
      subKind: "terminated",
      agentId: AGENT_ID,
      timestamp: Date.now(),
    };
    expect(isSkillEvent(event)).toBe(false);
  });
});

describe("isChannelEvent", () => {
  test("returns true for channel event", () => {
    const event: DashboardEvent = {
      kind: "channel",
      subKind: "connected",
      channelId: "ch-1",
      channelType: "cli",
      timestamp: Date.now(),
    };
    expect(isChannelEvent(event)).toBe(true);
  });

  test("returns false for non-channel event", () => {
    const event: DashboardEvent = {
      kind: "system",
      subKind: "error",
      message: "oops",
      timestamp: Date.now(),
    };
    expect(isChannelEvent(event)).toBe(false);
  });
});

describe("isSystemEvent", () => {
  test("returns true for system event", () => {
    const event: DashboardEvent = {
      kind: "system",
      subKind: "memory_warning",
      heapUsedMb: 512,
      heapLimitMb: 1024,
      timestamp: Date.now(),
    };
    expect(isSystemEvent(event)).toBe(true);
  });

  test("returns false for non-system event", () => {
    const event: DashboardEvent = {
      kind: "skill",
      subKind: "removed",
      name: "old-skill",
      timestamp: Date.now(),
    };
    expect(isSystemEvent(event)).toBe(false);
  });
});

describe("isForgeEvent", () => {
  test("returns true for forge event", () => {
    const event: DashboardEvent = {
      kind: "forge",
      subKind: "brick_forged",
      brickId: "brick-1",
      name: "my-tool",
      origin: "crystallize",
      ngramKey: "a>b>c",
      occurrences: 5,
      score: 0.9,
      timestamp: Date.now(),
    };
    expect(isForgeEvent(event)).toBe(true);
  });

  test("returns false for non-forge event", () => {
    const event: DashboardEvent = {
      kind: "agent",
      subKind: "terminated",
      agentId: AGENT_ID,
      timestamp: Date.now(),
    };
    expect(isForgeEvent(event)).toBe(false);
  });
});

describe("isMonitorEvent", () => {
  test("returns true for monitor event", () => {
    const event: DashboardEvent = {
      kind: "monitor",
      subKind: "anomaly_detected",
      anomalyKind: "tool_rate_exceeded",
      agentId: "agent-1",
      sessionId: "sess-1",
      detail: { toolName: "read_file", rate: 42 },
      timestamp: Date.now(),
    };
    expect(isMonitorEvent(event)).toBe(true);
  });

  test("returns false for non-monitor event", () => {
    const event: DashboardEvent = {
      kind: "system",
      subKind: "activity",
      message: "test",
      timestamp: Date.now(),
    };
    expect(isMonitorEvent(event)).toBe(false);
  });
});

describe("createKindGuard covers all valid kinds", () => {
  const ALL_KINDS = [
    "agent",
    "skill",
    "channel",
    "system",
    "nexus",
    "gateway",
    "temporal",
    "scheduler",
    "taskboard",
    "harness",
    "datasource",
    "forge",
    "monitor",
    "pty_output",
    "log",
  ] as const;

  test.each([...ALL_KINDS])("isDashboardEvent accepts kind '%s'", (kind) => {
    const event = { kind, subKind: "test_sub", timestamp: Date.now() };
    expect(isDashboardEvent(event)).toBe(true);
  });

  test("rejects kind not in VALID_KINDS", () => {
    expect(isDashboardEvent({ kind: "unknown", subKind: "x", timestamp: 1 })).toBe(false);
  });
});

describe("isDashboardEvent with forge and monitor", () => {
  test("returns true for valid forge event", () => {
    expect(
      isDashboardEvent({
        kind: "forge",
        subKind: "demand_detected",
        signalId: "sig-1",
        triggerKind: "capability_gap",
        confidence: 0.85,
        suggestedBrickKind: "tool",
        timestamp: Date.now(),
      }),
    ).toBe(true);
  });

  test("returns true for valid monitor event", () => {
    expect(
      isDashboardEvent({
        kind: "monitor",
        subKind: "anomaly_detected",
        anomalyKind: "error_spike",
        agentId: "a-1",
        sessionId: "s-1",
        detail: {},
        timestamp: Date.now(),
      }),
    ).toBe(true);
  });
});
