import { describe, expect, test } from "bun:test";
import type { AgentId } from "@koi/core";
import type { DashboardEvent } from "./events.js";
import {
  isAgentEvent,
  isChannelEvent,
  isDashboardEvent,
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
