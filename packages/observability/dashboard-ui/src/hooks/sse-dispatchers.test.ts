/**
 * Tests for SSE domain dispatchers — verifies routing by event.kind
 * and correct store mutations for each agent sub-event.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentId, ProcessState } from "@koi/core";
import type {
  AgentDashboardEvent,
  DashboardAgentSummary,
  DashboardEvent,
  GatewayDashboardEvent,
  HarnessDashboardEvent,
  NexusDashboardEvent,
  SchedulerDashboardEvent,
  TaskBoardDashboardEvent,
  TemporalDashboardEvent,
} from "@koi/dashboard-types";
import { useAgentsStore } from "../stores/agents-store.js";
import { useTreeStore } from "../stores/tree-store.js";
import { dispatchDashboardEvent } from "./sse-dispatchers.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Mock fetchAgents at the module level. The dispatchers module imports
 * fetchAgents from "../lib/api-client.js" and calls it on "dispatched" events.
 */
const mockFetchAgents = mock(() => Promise.resolve([] as readonly DashboardAgentSummary[]));
mock.module("../lib/api-client.js", () => ({
  fetchAgents: mockFetchAgents,
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_ID = "agent-test-1" as AgentId;
const NOW = 1700000000000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(
  id: string,
  overrides?: Partial<DashboardAgentSummary>,
): DashboardAgentSummary {
  return {
    agentId: id as DashboardAgentSummary["agentId"],
    name: `agent-${id}`,
    agentType: "copilot",
    state: "running",
    channels: ["cli"],
    turns: 0,
    startedAt: NOW,
    lastActivityAt: NOW,
    ...overrides,
  };
}

function seedAgentStore(agents: readonly DashboardAgentSummary[]): void {
  const record: Record<string, DashboardAgentSummary> = {};
  for (const agent of agents) {
    record[agent.agentId] = agent;
  }
  useAgentsStore.setState({
    agents: record,
    lastFullRefresh: NOW,
    isLoading: false,
    initialLoadDone: true,
    error: null,
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset agents store to clean state
  useAgentsStore.setState({
    agents: {},
    lastFullRefresh: 0,
    isLoading: true,
    initialLoadDone: false,
    error: null,
  });

  // Reset tree store to clean state
  useTreeStore.setState({
    expanded: new Set<string>(),
    selectedPath: null,
    selectedIsDirectory: false,
    lastInvalidatedAt: 0,
  });

  // Clear mock call history
  mockFetchAgents.mockClear();
  mockFetchAgents.mockImplementation(() => Promise.resolve([] as readonly DashboardAgentSummary[]));
});

afterEach(() => {
  // Clear any lingering debounce timers between tests.
  // Fire a dummy nexus event and immediately clear so no timer leaks.
  // This is a belt-and-suspenders approach; each test should also
  // manage its own timers.
});

// ===========================================================================
// 1. Top-level routing: dispatchDashboardEvent routes by event.kind
// ===========================================================================

describe("dispatchDashboardEvent routing", () => {
  test("routes agent events to agent dispatcher", () => {
    seedAgentStore([makeSummary(AGENT_ID)]);

    const event: AgentDashboardEvent = {
      kind: "agent",
      subKind: "status_changed",
      agentId: AGENT_ID,
      from: "running" as ProcessState,
      to: "waiting" as ProcessState,
      timestamp: NOW + 1000,
    };

    dispatchDashboardEvent(event);

    const agent = useAgentsStore.getState().agents[AGENT_ID];
    expect(agent?.state).toBe("waiting");
  });

  test("routes nexus events to nexus dispatcher (tree invalidation)", async () => {
    const event: NexusDashboardEvent = {
      kind: "nexus",
      subKind: "file_changed",
      path: "/workspace/test.ts",
      changeType: "updated",
      timestamp: NOW,
    };

    dispatchDashboardEvent(event);

    // Tree invalidation is debounced at 200ms; wait for it to fire.
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });

    expect(useTreeStore.getState().lastInvalidatedAt).toBeGreaterThan(0);
  });

  test("routes gateway events to gateway dispatcher (tree invalidation)", async () => {
    const event: GatewayDashboardEvent = {
      kind: "gateway",
      subKind: "topology_changed",
      nodeCount: 3,
      connectionCount: 5,
      timestamp: NOW,
    };

    dispatchDashboardEvent(event);

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });

    expect(useTreeStore.getState().lastInvalidatedAt).toBeGreaterThan(0);
  });

  test("routes temporal events without throwing", () => {
    const event: TemporalDashboardEvent = {
      kind: "temporal",
      subKind: "workflow_started",
      workflowId: "wf-1",
      workflowType: "agent-loop",
      timestamp: NOW,
    };

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });

  test("routes scheduler events without throwing", () => {
    const event: SchedulerDashboardEvent = {
      kind: "scheduler",
      subKind: "task_submitted",
      taskId: "task-1",
      agentId: AGENT_ID,
      timestamp: NOW,
    };

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });

  test("routes taskboard events without throwing", () => {
    const event: TaskBoardDashboardEvent = {
      kind: "taskboard",
      subKind: "task_status_changed",
      taskId: "task-1",
      status: "completed",
      timestamp: NOW,
    };

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });

  test("routes harness events without throwing", () => {
    const event: HarnessDashboardEvent = {
      kind: "harness",
      subKind: "checkpoint_created",
      checkpointType: "soft",
      timestamp: NOW,
    };

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });

  test("unknown event kinds do not throw", () => {
    // Force an event with a kind not in the switch statement.
    const event = {
      kind: "skill",
      subKind: "installed",
      name: "my-skill",
      timestamp: NOW,
    } as DashboardEvent;

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });

  test("channel event kind does not throw", () => {
    const event = {
      kind: "channel",
      subKind: "connected",
      channelId: "ch-1",
      channelType: "cli",
      timestamp: NOW,
    } as DashboardEvent;

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });

  test("system event kind does not throw", () => {
    const event = {
      kind: "system",
      subKind: "activity",
      message: "heartbeat",
      timestamp: NOW,
    } as DashboardEvent;

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });
});

// ===========================================================================
// 2. Agent events — status_changed
// ===========================================================================

describe("agent status_changed", () => {
  test("updates agent state and lastActivityAt", () => {
    seedAgentStore([makeSummary(AGENT_ID, { state: "running" })]);

    const event: AgentDashboardEvent = {
      kind: "agent",
      subKind: "status_changed",
      agentId: AGENT_ID,
      from: "running" as ProcessState,
      to: "suspended" as ProcessState,
      timestamp: NOW + 5000,
    };

    dispatchDashboardEvent(event);

    const agent = useAgentsStore.getState().agents[AGENT_ID];
    expect(agent?.state).toBe("suspended");
    expect(agent?.lastActivityAt).toBe(NOW + 5000);
  });

  test("preserves other agent fields on status change", () => {
    seedAgentStore([makeSummary(AGENT_ID, { turns: 42, name: "my-agent" })]);

    const event: AgentDashboardEvent = {
      kind: "agent",
      subKind: "status_changed",
      agentId: AGENT_ID,
      from: "running" as ProcessState,
      to: "waiting" as ProcessState,
      timestamp: NOW + 1000,
    };

    dispatchDashboardEvent(event);

    const agent = useAgentsStore.getState().agents[AGENT_ID];
    expect(agent?.turns).toBe(42);
    expect(agent?.name).toBe("my-agent");
  });

  test("ignores status change for unknown agent", () => {
    seedAgentStore([makeSummary(AGENT_ID)]);

    const event: AgentDashboardEvent = {
      kind: "agent",
      subKind: "status_changed",
      agentId: "nonexistent" as AgentId,
      from: "running" as ProcessState,
      to: "terminated" as ProcessState,
      timestamp: NOW,
    };

    dispatchDashboardEvent(event);

    // Original agent untouched, nonexistent not created
    expect(useAgentsStore.getState().agents[AGENT_ID]).toBeDefined();
    expect(useAgentsStore.getState().agents.nonexistent).toBeUndefined();
  });
});

// ===========================================================================
// 3. Agent events — dispatched (triggers full refetch)
// ===========================================================================

describe("agent dispatched", () => {
  test("calls fetchAgents to refresh the store", () => {
    const event: AgentDashboardEvent = {
      kind: "agent",
      subKind: "dispatched",
      agentId: AGENT_ID,
      name: "new-agent",
      agentType: "copilot",
      timestamp: NOW,
    };

    dispatchDashboardEvent(event);

    expect(mockFetchAgents).toHaveBeenCalledTimes(1);
  });

  test("sets fetched agents into the store after resolve", async () => {
    const freshAgents: readonly DashboardAgentSummary[] = [
      makeSummary(AGENT_ID, { name: "fresh-agent" }),
      makeSummary("agent-2" as string, { name: "other-agent" }),
    ];
    mockFetchAgents.mockImplementation(() => Promise.resolve(freshAgents));

    const event: AgentDashboardEvent = {
      kind: "agent",
      subKind: "dispatched",
      agentId: AGENT_ID,
      name: "new-agent",
      agentType: "copilot",
      timestamp: NOW,
    };

    dispatchDashboardEvent(event);

    // Wait a tick for the promise chain to resolve
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    const state = useAgentsStore.getState();
    expect(Object.keys(state.agents)).toHaveLength(2);
    expect(state.agents[AGENT_ID]?.name).toBe("fresh-agent");
  });

  test("does not throw synchronously even when fetchAgents is slow", () => {
    // Use a never-resolving promise to verify that the synchronous dispatch
    // path completes without blocking or throwing, regardless of fetchAgents.
    mockFetchAgents.mockImplementation(
      () => new Promise<readonly DashboardAgentSummary[]>(() => {}),
    );

    const event: AgentDashboardEvent = {
      kind: "agent",
      subKind: "dispatched",
      agentId: AGENT_ID,
      name: "new-agent",
      agentType: "worker",
      timestamp: NOW,
    };

    // Should not throw synchronously — the fetch is fire-and-forget.
    expect(() => dispatchDashboardEvent(event)).not.toThrow();
    expect(mockFetchAgents).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 4. Agent events — terminated
// ===========================================================================

describe("agent terminated", () => {
  test("removes agent from the store", () => {
    seedAgentStore([makeSummary(AGENT_ID), makeSummary("agent-2" as string)]);

    const event: AgentDashboardEvent = {
      kind: "agent",
      subKind: "terminated",
      agentId: AGENT_ID,
      reason: "user request",
      timestamp: NOW,
    };

    dispatchDashboardEvent(event);

    const state = useAgentsStore.getState();
    expect(state.agents[AGENT_ID]).toBeUndefined();
    expect(state.agents["agent-2"]).toBeDefined();
  });

  test("removing nonexistent agent is a no-op", () => {
    seedAgentStore([makeSummary(AGENT_ID)]);

    const event: AgentDashboardEvent = {
      kind: "agent",
      subKind: "terminated",
      agentId: "nonexistent" as AgentId,
      timestamp: NOW,
    };

    dispatchDashboardEvent(event);

    // Original agent still present
    expect(Object.keys(useAgentsStore.getState().agents)).toHaveLength(1);
  });
});

// ===========================================================================
// 5. Agent events — metrics_updated
// ===========================================================================

describe("agent metrics_updated", () => {
  test("updates turns and lastActivityAt for existing agent", () => {
    seedAgentStore([makeSummary(AGENT_ID, { turns: 5 })]);

    const event: AgentDashboardEvent = {
      kind: "agent",
      subKind: "metrics_updated",
      agentId: AGENT_ID,
      turns: 12,
      tokenCount: 3500,
      timestamp: NOW + 2000,
    };

    dispatchDashboardEvent(event);

    const agent = useAgentsStore.getState().agents[AGENT_ID];
    expect(agent?.turns).toBe(12);
    expect(agent?.lastActivityAt).toBe(NOW + 2000);
  });

  test("preserves other fields on metrics update", () => {
    seedAgentStore([makeSummary(AGENT_ID, { state: "running", name: "keepme" })]);

    const event: AgentDashboardEvent = {
      kind: "agent",
      subKind: "metrics_updated",
      agentId: AGENT_ID,
      turns: 99,
      tokenCount: 10000,
      timestamp: NOW + 3000,
    };

    dispatchDashboardEvent(event);

    const agent = useAgentsStore.getState().agents[AGENT_ID];
    expect(agent?.state).toBe("running");
    expect(agent?.name).toBe("keepme");
  });

  test("ignores metrics update for unknown agent", () => {
    seedAgentStore([makeSummary(AGENT_ID)]);

    const event: AgentDashboardEvent = {
      kind: "agent",
      subKind: "metrics_updated",
      agentId: "ghost" as AgentId,
      turns: 999,
      tokenCount: 50000,
      timestamp: NOW,
    };

    dispatchDashboardEvent(event);

    expect(useAgentsStore.getState().agents.ghost).toBeUndefined();
    expect(useAgentsStore.getState().agents[AGENT_ID]?.turns).toBe(0);
  });
});

// ===========================================================================
// 6. Nexus events — debounced tree invalidation
// ===========================================================================

describe("nexus events", () => {
  test("invalidates tree after 200ms debounce", async () => {
    const event: NexusDashboardEvent = {
      kind: "nexus",
      subKind: "file_changed",
      path: "/workspace/src/index.ts",
      changeType: "created",
      timestamp: NOW,
    };

    dispatchDashboardEvent(event);

    // Not yet invalidated (debounce has not fired)
    expect(useTreeStore.getState().lastInvalidatedAt).toBe(0);

    // Wait for debounce to fire
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });

    expect(useTreeStore.getState().lastInvalidatedAt).toBeGreaterThan(0);
  });

  test("coalesces multiple rapid nexus events into one invalidation", async () => {
    const baseEvent: NexusDashboardEvent = {
      kind: "nexus",
      subKind: "file_changed",
      path: "/workspace/a.ts",
      changeType: "updated",
      timestamp: NOW,
    };

    // Fire 5 events in quick succession
    dispatchDashboardEvent(baseEvent);
    dispatchDashboardEvent({ ...baseEvent, path: "/workspace/b.ts" });
    dispatchDashboardEvent({ ...baseEvent, path: "/workspace/c.ts" });
    dispatchDashboardEvent({ ...baseEvent, path: "/workspace/d.ts" });
    dispatchDashboardEvent({ ...baseEvent, path: "/workspace/e.ts" });

    // Wait for debounce to fire
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });

    const invalidatedAt = useTreeStore.getState().lastInvalidatedAt;
    expect(invalidatedAt).toBeGreaterThan(0);

    // Record the timestamp and wait again — no second invalidation should occur
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });

    expect(useTreeStore.getState().lastInvalidatedAt).toBe(invalidatedAt);
  });

  test("namespace_changed also triggers tree invalidation", async () => {
    const event: NexusDashboardEvent = {
      kind: "nexus",
      subKind: "namespace_changed",
      agentId: AGENT_ID,
      timestamp: NOW,
    };

    dispatchDashboardEvent(event);

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });

    expect(useTreeStore.getState().lastInvalidatedAt).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 7. Gateway events — debounced tree invalidation
// ===========================================================================

describe("gateway events", () => {
  test("connection_changed triggers debounced tree invalidation", async () => {
    const event: GatewayDashboardEvent = {
      kind: "gateway",
      subKind: "connection_changed",
      channelId: "ch-1",
      channelType: "websocket",
      connected: true,
      timestamp: NOW,
    };

    dispatchDashboardEvent(event);

    // Not yet invalidated
    expect(useTreeStore.getState().lastInvalidatedAt).toBe(0);

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });

    expect(useTreeStore.getState().lastInvalidatedAt).toBeGreaterThan(0);
  });

  test("topology_changed triggers debounced tree invalidation", async () => {
    const event: GatewayDashboardEvent = {
      kind: "gateway",
      subKind: "topology_changed",
      nodeCount: 2,
      connectionCount: 4,
      timestamp: NOW,
    };

    dispatchDashboardEvent(event);

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });

    expect(useTreeStore.getState().lastInvalidatedAt).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 8. No-op domain dispatchers — temporal, scheduler, taskboard, harness
// ===========================================================================

describe("no-op domain dispatchers", () => {
  test("temporal workflow_started is a no-op", () => {
    const event: TemporalDashboardEvent = {
      kind: "temporal",
      subKind: "workflow_started",
      workflowId: "wf-1",
      workflowType: "agent-loop",
      timestamp: NOW,
    };

    expect(() => dispatchDashboardEvent(event)).not.toThrow();

    // Stores should be untouched
    expect(useAgentsStore.getState().agents).toEqual({});
    expect(useTreeStore.getState().lastInvalidatedAt).toBe(0);
  });

  test("temporal workflow_completed is a no-op", () => {
    const event: TemporalDashboardEvent = {
      kind: "temporal",
      subKind: "workflow_completed",
      workflowId: "wf-1",
      timestamp: NOW,
    };

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });

  test("temporal health_changed is a no-op", () => {
    const event: TemporalDashboardEvent = {
      kind: "temporal",
      subKind: "health_changed",
      healthy: false,
      timestamp: NOW,
    };

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });

  test("scheduler task_submitted is a no-op", () => {
    const event: SchedulerDashboardEvent = {
      kind: "scheduler",
      subKind: "task_submitted",
      taskId: "t-1",
      agentId: AGENT_ID,
      timestamp: NOW,
    };

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });

  test("scheduler task_completed is a no-op", () => {
    const event: SchedulerDashboardEvent = {
      kind: "scheduler",
      subKind: "task_completed",
      taskId: "t-1",
      timestamp: NOW,
    };

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });

  test("scheduler task_dead_letter is a no-op", () => {
    const event: SchedulerDashboardEvent = {
      kind: "scheduler",
      subKind: "task_dead_letter",
      taskId: "t-1",
      timestamp: NOW,
    };

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });

  test("scheduler schedule_fired is a no-op", () => {
    const event: SchedulerDashboardEvent = {
      kind: "scheduler",
      subKind: "schedule_fired",
      scheduleId: "sched-1",
      timestamp: NOW,
    };

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });

  test("taskboard task_status_changed is a no-op", () => {
    const event: TaskBoardDashboardEvent = {
      kind: "taskboard",
      subKind: "task_status_changed",
      taskId: "tb-1",
      status: "running",
      timestamp: NOW,
    };

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });

  test("harness checkpoint_created is a no-op", () => {
    const event: HarnessDashboardEvent = {
      kind: "harness",
      subKind: "checkpoint_created",
      checkpointType: "hard",
      timestamp: NOW,
    };

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });

  test("harness phase_changed is a no-op", () => {
    const event: HarnessDashboardEvent = {
      kind: "harness",
      subKind: "phase_changed",
      from: "init",
      to: "running",
      timestamp: NOW,
    };

    expect(() => dispatchDashboardEvent(event)).not.toThrow();
  });
});

// ===========================================================================
// 9. Cross-domain debounce sharing between nexus and gateway
// ===========================================================================

describe("nexus and gateway share debounce timer", () => {
  test("interleaved nexus and gateway events coalesce into one invalidation", async () => {
    const nexusEvent: NexusDashboardEvent = {
      kind: "nexus",
      subKind: "file_changed",
      path: "/workspace/x.ts",
      changeType: "deleted",
      timestamp: NOW,
    };

    const gatewayEvent: GatewayDashboardEvent = {
      kind: "gateway",
      subKind: "topology_changed",
      nodeCount: 1,
      connectionCount: 2,
      timestamp: NOW,
    };

    dispatchDashboardEvent(nexusEvent);
    dispatchDashboardEvent(gatewayEvent);
    dispatchDashboardEvent(nexusEvent);

    // Still debouncing — no invalidation yet
    expect(useTreeStore.getState().lastInvalidatedAt).toBe(0);

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });

    const invalidatedAt = useTreeStore.getState().lastInvalidatedAt;
    expect(invalidatedAt).toBeGreaterThan(0);

    // No further invalidation after the debounce window
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });

    expect(useTreeStore.getState().lastInvalidatedAt).toBe(invalidatedAt);
  });
});

// ===========================================================================
// 10. Multiple agent events in sequence (batch simulation)
// ===========================================================================

describe("sequential agent event processing", () => {
  test("processes a batch of mixed agent events correctly", () => {
    const agent1 = makeSummary("a1" as string, { state: "running", turns: 0 });
    const agent2 = makeSummary("a2" as string, { state: "created", turns: 0 });
    seedAgentStore([agent1, agent2]);

    // Event 1: a1 status changes
    dispatchDashboardEvent({
      kind: "agent",
      subKind: "status_changed",
      agentId: "a1" as AgentId,
      from: "running" as ProcessState,
      to: "waiting" as ProcessState,
      timestamp: NOW + 100,
    } satisfies AgentDashboardEvent);

    // Event 2: a2 metrics updated
    dispatchDashboardEvent({
      kind: "agent",
      subKind: "metrics_updated",
      agentId: "a2" as AgentId,
      turns: 7,
      tokenCount: 1500,
      timestamp: NOW + 200,
    } satisfies AgentDashboardEvent);

    // Event 3: a1 terminated
    dispatchDashboardEvent({
      kind: "agent",
      subKind: "terminated",
      agentId: "a1" as AgentId,
      reason: "completed",
      timestamp: NOW + 300,
    } satisfies AgentDashboardEvent);

    const state = useAgentsStore.getState();
    expect(state.agents.a1).toBeUndefined();
    expect(state.agents.a2?.turns).toBe(7);
    expect(state.agents.a2?.lastActivityAt).toBe(NOW + 200);
  });
});
