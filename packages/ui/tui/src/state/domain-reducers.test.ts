import { describe, expect, test } from "bun:test";
import type {
  ChannelDashboardEvent,
  GatewayDashboardEvent,
  HarnessDashboardEvent,
  NexusDashboardEvent,
  SchedulerDashboardEvent,
  SkillDashboardEvent,
  SystemDashboardEvent,
  TaskBoardDashboardEvent,
  TemporalDashboardEvent,
} from "@koi/dashboard-types";
import {
  addGovernanceApproval,
  addGovernanceViolation,
  clampScroll,
  computeDagLayout,
  reduceChannels,
  reduceGateway,
  reduceHarness,
  reduceNexus,
  reduceScheduler,
  reduceSkills,
  reduceSystem,
  reduceTaskBoard,
  reduceTemporal,
  removeGovernanceApproval,
} from "./domain-reducers.js";
import {
  createInitialChannelsView,
  createInitialGatewayView,
  createInitialGovernanceView,
  createInitialHarnessView,
  createInitialNexusView,
  createInitialSchedulerView,
  createInitialSkillsView,
  createInitialSystemView,
  createInitialTaskBoardView,
  createInitialTemporalView,
  MAX_SKILL_EVENTS,
} from "./domain-types.js";

function makeSkillEvent(subKind: "installed" | "removed", name: string): SkillDashboardEvent {
  return { kind: "skill", subKind, name, timestamp: Date.now() };
}

function makeChannelEvent(
  subKind: "connected" | "disconnected",
  channelId: string,
): ChannelDashboardEvent {
  return { kind: "channel", subKind, channelId, timestamp: Date.now() } as ChannelDashboardEvent;
}

function makeSystemEvent(subKind: "error", message: string): SystemDashboardEvent {
  return { kind: "system", subKind, message, timestamp: Date.now() };
}

function makeNexusEvent(): NexusDashboardEvent {
  return {
    kind: "nexus",
    subKind: "file_changed",
    path: "/test",
    changeType: "created",
    timestamp: Date.now(),
  };
}

function makeGatewayEvent(): GatewayDashboardEvent {
  return {
    kind: "gateway",
    subKind: "topology_changed",
    nodeCount: 3,
    connectionCount: 5,
    timestamp: Date.now(),
  };
}

function makeTemporalEvent(): TemporalDashboardEvent {
  return {
    kind: "temporal",
    subKind: "workflow_started",
    workflowId: "wf-1",
    workflowType: "agent",
    timestamp: Date.now(),
  };
}

function makeSchedulerEvent(): SchedulerDashboardEvent {
  return {
    kind: "scheduler",
    subKind: "task_submitted",
    taskId: "t-1",
    agentId: "a-1" as import("@koi/core").AgentId,
    timestamp: Date.now(),
  };
}

function makeTaskBoardEvent(): TaskBoardDashboardEvent {
  return {
    kind: "taskboard",
    subKind: "task_status_changed",
    taskId: "t-1",
    status: "running",
    timestamp: Date.now(),
  };
}

function makeHarnessEvent(): HarnessDashboardEvent {
  return {
    kind: "harness",
    subKind: "phase_changed",
    from: "idle",
    to: "running",
    timestamp: Date.now(),
  };
}

describe("reduceSkills", () => {
  test("appends skill event", () => {
    const state = createInitialSkillsView();
    const next = reduceSkills(state, makeSkillEvent("installed", "search"));
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.subKind).toBe("installed");
  });

  test("caps at MAX_SKILL_EVENTS", () => {
    let state = createInitialSkillsView();
    for (let i = 0; i < MAX_SKILL_EVENTS + 5; i++) {
      state = reduceSkills(state, makeSkillEvent("installed", `skill-${String(i)}`));
    }
    expect(state.events).toHaveLength(MAX_SKILL_EVENTS);
  });
});

describe("reduceChannels", () => {
  test("appends channel event", () => {
    const state = createInitialChannelsView();
    const next = reduceChannels(state, makeChannelEvent("connected", "ch-1"));
    expect(next.events).toHaveLength(1);
  });
});

describe("reduceSystem", () => {
  test("appends system event", () => {
    const state = createInitialSystemView();
    const next = reduceSystem(state, makeSystemEvent("error", "test error"));
    expect(next.events).toHaveLength(1);
  });
});

describe("reduceNexus", () => {
  test("appends nexus event", () => {
    const state = createInitialNexusView();
    const next = reduceNexus(state, makeNexusEvent());
    expect(next.events).toHaveLength(1);
  });
});

describe("reduceGateway", () => {
  test("appends gateway event", () => {
    const state = createInitialGatewayView();
    const next = reduceGateway(state, makeGatewayEvent());
    expect(next.events).toHaveLength(1);
  });
});

describe("reduceTemporal", () => {
  test("appends temporal event", () => {
    const state = createInitialTemporalView();
    const next = reduceTemporal(state, makeTemporalEvent());
    expect(next.events).toHaveLength(1);
  });
});

describe("reduceScheduler", () => {
  test("appends scheduler event", () => {
    const state = createInitialSchedulerView();
    const next = reduceScheduler(state, makeSchedulerEvent());
    expect(next.events).toHaveLength(1);
  });
});

describe("reduceTaskBoard", () => {
  test("appends event and invalidates layout cache", () => {
    const state = { ...createInitialTaskBoardView(), cachedLayout: ["old"] };
    const next = reduceTaskBoard(state, makeTaskBoardEvent());
    expect(next.events).toHaveLength(1);
    expect(next.cachedLayout).toBeNull();
  });
});

describe("reduceHarness", () => {
  test("appends harness event", () => {
    const state = createInitialHarnessView();
    const next = reduceHarness(state, makeHarnessEvent());
    expect(next.events).toHaveLength(1);
  });
});

describe("computeDagLayout", () => {
  test("returns empty message for no nodes", () => {
    const result = computeDagLayout([], []);
    expect(result).toEqual(["(empty)"]);
  });

  test("renders single node", () => {
    const nodes = [{ taskId: "t1", label: "Task 1", status: "running" as const }];
    const result = computeDagLayout(nodes, []);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toContain("Task 1");
  });

  test("renders DAG with edges", () => {
    const nodes = [
      { taskId: "t1", label: "Start", status: "completed" as const },
      { taskId: "t2", label: "End", status: "pending" as const },
    ];
    const edges = [{ from: "t1", to: "t2" }];
    const result = computeDagLayout(nodes, edges);
    expect(result.length).toBeGreaterThan(1);
  });
});

describe("governance reducers", () => {
  test("addGovernanceApproval adds item", () => {
    const state = createInitialGovernanceView();
    const next = addGovernanceApproval(state, {
      id: "ap-1",
      agentId: "a-1",
      action: "write",
      resource: "/data",
      timestamp: Date.now(),
    });
    expect(next.pendingApprovals).toHaveLength(1);
  });

  test("addGovernanceApproval deduplicates by id", () => {
    const state = createInitialGovernanceView();
    const item = {
      id: "ap-1",
      agentId: "a-1",
      action: "write",
      resource: "/data",
      timestamp: Date.now(),
    };
    const once = addGovernanceApproval(state, item);
    const twice = addGovernanceApproval(once, item);
    expect(twice.pendingApprovals).toHaveLength(1);
    expect(twice).toBe(once); // same reference — no-op
  });

  test("removeGovernanceApproval removes by id", () => {
    const state = addGovernanceApproval(createInitialGovernanceView(), {
      id: "ap-1",
      agentId: "a-1",
      action: "write",
      resource: "/data",
      timestamp: Date.now(),
    });
    const next = removeGovernanceApproval(state, "ap-1");
    expect(next.pendingApprovals).toHaveLength(0);
  });

  test("addGovernanceViolation adds item", () => {
    const state = createInitialGovernanceView();
    const next = addGovernanceViolation(state, {
      id: "v-1",
      agentId: "a-1",
      rule: "no-write",
      action: "write",
      timestamp: Date.now(),
    });
    expect(next.violations).toHaveLength(1);
  });
});

describe("clampScroll", () => {
  test("clamps negative offset to 0", () => {
    expect(clampScroll(-5, 100, 20)).toBe(0);
  });

  test("clamps offset beyond max to itemCount - visibleRows", () => {
    expect(clampScroll(90, 100, 20)).toBe(80);
  });

  test("returns 0 when items fit in visible rows", () => {
    expect(clampScroll(5, 10, 20)).toBe(0);
  });

  test("allows valid offset in range", () => {
    expect(clampScroll(30, 100, 20)).toBe(30);
  });
});
