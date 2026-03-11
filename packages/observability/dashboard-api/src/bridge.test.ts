/**
 * Tests for createAdminPanelBridge — adapts live runtime state into
 * DashboardDataSource for the admin panel.
 */

import { describe, expect, mock, test } from "bun:test";
import { agentId } from "@koi/core";
import type { DashboardEvent } from "@koi/dashboard-types";
import type { BridgeOptions } from "./bridge.js";
import { createAdminPanelBridge } from "./bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestOptions(overrides?: Partial<BridgeOptions>): BridgeOptions {
  return {
    agentName: "test-agent",
    agentType: "copilot",
    model: "anthropic:claude-sonnet-4-5-20250929",
    channels: [],
    skills: [],
    ...overrides,
  };
}

/** Helper to safely get the first element of an array, throwing if absent. */
function first<T>(arr: readonly T[]): T {
  const item = arr[0];
  if (item === undefined) throw new Error("Expected at least one element");
  return item;
}

/** Helper to unwrap a possibly-undefined value, throwing if absent. */
function unwrap<T>(value: T | undefined, label = "value"): T {
  if (value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAdminPanelBridge", () => {
  test("returns DashboardHandlerOptions with dataSource", () => {
    const result = createAdminPanelBridge(createTestOptions());

    expect(result.dataSource).toBeDefined();
    expect(typeof result.dataSource.listAgents).toBe("function");
    expect(typeof result.dataSource.getAgent).toBe("function");
    expect(typeof result.dataSource.terminateAgent).toBe("function");
    expect(typeof result.dataSource.listChannels).toBe("function");
    expect(typeof result.dataSource.listSkills).toBe("function");
    expect(typeof result.dataSource.getSystemMetrics).toBe("function");
    expect(typeof result.dataSource.subscribe).toBe("function");
  });

  test("listAgents returns single agent summary", async () => {
    const opts = createTestOptions({
      agentName: "my-worker",
      agentType: "worker",
      model: "openai:gpt-4o",
      channels: ["cli", "telegram"],
    });
    const { dataSource } = createAdminPanelBridge(opts);

    const agents = await dataSource.listAgents();
    expect(agents).toHaveLength(1);

    const agent = first(agents);
    expect(agent.name).toBe("my-worker");
    expect(agent.agentType).toBe("worker");
    expect(agent.model).toBe("openai:gpt-4o");
    expect(agent.channels).toEqual(["cli", "telegram"]);
    expect(agent.state).toBe("running");
    expect(agent.turns).toBe(0);
    expect(typeof agent.startedAt).toBe("number");
  });

  test("getAgent returns detail for the primary agent", async () => {
    const opts = createTestOptions({
      agentName: "detail-agent",
      skills: ["web-search", "code-review"],
    });
    const { dataSource } = createAdminPanelBridge(opts);

    const agents = await dataSource.listAgents();
    const detail = await dataSource.getAgent(first(agents).agentId);

    expect(detail).toBeDefined();
    expect(detail?.name).toBe("detail-agent");
    expect(detail?.skills).toEqual(["web-search", "code-review"]);
    expect(detail?.tokenCount).toBe(0);
    expect(detail?.metadata).toEqual({});
  });

  test("getAgent returns undefined for unknown agentId", async () => {
    const { dataSource } = createAdminPanelBridge(createTestOptions());

    const detail = await dataSource.getAgent(agentId("unknown-id"));
    expect(detail).toBeUndefined();
  });

  test("terminateAgent returns error for non-existent agent", async () => {
    const { dataSource } = createAdminPanelBridge(createTestOptions());

    const result = await dataSource.terminateAgent(agentId("unknown-id"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("terminateAgent succeeds for known agent", async () => {
    const { dataSource } = createAdminPanelBridge(createTestOptions());

    const agents = await dataSource.listAgents();
    const result = await dataSource.terminateAgent(first(agents).agentId);
    expect(result.ok).toBe(true);
  });

  test("listChannels returns configured channels", async () => {
    const opts = createTestOptions({
      channels: ["cli", "telegram", "slack"],
    });
    const { dataSource } = createAdminPanelBridge(opts);

    const channels = await dataSource.listChannels();
    expect(channels).toHaveLength(3);
    expect(first(channels).channelType).toBe("cli");
    expect(channels[1]?.channelType).toBe("telegram");
    expect(channels[2]?.channelType).toBe("slack");
    // All channels should be marked as connected
    for (const ch of channels) {
      expect(ch.connected).toBe(true);
    }
  });

  test("listChannels returns empty array when no channels", async () => {
    const { dataSource } = createAdminPanelBridge(createTestOptions());

    const channels = await dataSource.listChannels();
    expect(channels).toEqual([]);
  });

  test("listSkills returns configured skills", async () => {
    const opts = createTestOptions({
      skills: ["web-search", "code-review"],
    });
    const { dataSource } = createAdminPanelBridge(opts);

    const skills = await dataSource.listSkills();
    expect(skills).toHaveLength(2);
    expect(first(skills).name).toBe("web-search");
    expect(skills[1]?.name).toBe("code-review");
  });

  test("listSkills returns empty array when no skills", async () => {
    const { dataSource } = createAdminPanelBridge(createTestOptions());

    const skills = await dataSource.listSkills();
    expect(skills).toEqual([]);
  });

  test("getSystemMetrics returns basic metrics", async () => {
    const { dataSource } = createAdminPanelBridge(createTestOptions());

    const metrics = await dataSource.getSystemMetrics();
    expect(metrics.activeAgents).toBe(1);
    expect(metrics.totalAgents).toBe(1);
    expect(typeof metrics.uptimeMs).toBe("number");
    expect(typeof metrics.heapUsedMb).toBe("number");
    expect(typeof metrics.heapTotalMb).toBe("number");
    expect(metrics.activeChannels).toBe(0);
  });

  test("getSystemMetrics reflects channel count", async () => {
    const opts = createTestOptions({ channels: ["cli", "slack"] });
    const { dataSource } = createAdminPanelBridge(opts);

    const metrics = await dataSource.getSystemMetrics();
    expect(metrics.activeChannels).toBe(2);
  });

  test("subscribe returns unsubscribe function", () => {
    const { dataSource } = createAdminPanelBridge(createTestOptions());

    const listener = mock((_event: DashboardEvent) => {});
    const unsub = dataSource.subscribe(listener);
    expect(typeof unsub).toBe("function");

    // Calling unsub should not throw
    unsub();
  });

  test("emitEvent notifies subscribers", () => {
    const result = createAdminPanelBridge(createTestOptions());

    const events: DashboardEvent[] = [];
    result.dataSource.subscribe((event) => {
      events.push(event);
    });

    result.emitEvent({
      kind: "system",
      subKind: "activity",
      message: "test event",
      timestamp: Date.now(),
    });

    expect(events).toHaveLength(1);
    expect(first(events).kind).toBe("system");
  });

  test("unsubscribe prevents further event delivery", () => {
    const result = createAdminPanelBridge(createTestOptions());

    const events: DashboardEvent[] = [];
    const unsub = result.dataSource.subscribe((event) => {
      events.push(event);
    });

    result.emitEvent({
      kind: "system",
      subKind: "activity",
      message: "before unsub",
      timestamp: Date.now(),
    });

    unsub();

    result.emitEvent({
      kind: "system",
      subKind: "activity",
      message: "after unsub",
      timestamp: Date.now(),
    });

    expect(events).toHaveLength(1);
  });

  test("multiple subscribers each receive events", () => {
    const result = createAdminPanelBridge(createTestOptions());

    const events1: DashboardEvent[] = [];
    const events2: DashboardEvent[] = [];
    result.dataSource.subscribe((e) => events1.push(e));
    result.dataSource.subscribe((e) => events2.push(e));

    result.emitEvent({
      kind: "system",
      subKind: "activity",
      message: "broadcast",
      timestamp: Date.now(),
    });

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
  });

  test("agent state updates after terminateAgent", async () => {
    const { dataSource } = createAdminPanelBridge(createTestOptions());

    const agents = await dataSource.listAgents();
    const id = first(agents).agentId;

    await dataSource.terminateAgent(id);

    const agentsAfter = await dataSource.listAgents();
    expect(first(agentsAfter).state).toBe("terminated");

    const detail = await dataSource.getAgent(id);
    expect(detail?.state).toBe("terminated");
  });

  test("terminateAgent on already terminated agent returns error", async () => {
    const { dataSource } = createAdminPanelBridge(createTestOptions());

    const agents = await dataSource.listAgents();
    const id = first(agents).agentId;

    // First termination succeeds
    const firstResult = await dataSource.terminateAgent(id);
    expect(firstResult.ok).toBe(true);

    // Second termination fails
    const second = await dataSource.terminateAgent(id);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("CONFLICT");
    }
  });

  test("terminateAgent emits dashboard event", async () => {
    const result = createAdminPanelBridge(createTestOptions());

    const events: DashboardEvent[] = [];
    result.dataSource.subscribe((e) => events.push(e));

    const agents = await result.dataSource.listAgents();
    await result.dataSource.terminateAgent(first(agents).agentId);

    expect(events.some((e) => e.kind === "agent" && e.subKind === "status_changed")).toBe(true);
  });

  test("gracefully handles empty channels and skills arrays", async () => {
    const { dataSource } = createAdminPanelBridge(createTestOptions({ channels: [], skills: [] }));

    const channels = await dataSource.listChannels();
    const skills = await dataSource.listSkills();
    expect(channels).toEqual([]);
    expect(skills).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // runtimeViews
  // ---------------------------------------------------------------------------

  test("returns runtimeViews in result", () => {
    const result = createAdminPanelBridge(createTestOptions());

    expect(result.runtimeViews).toBeDefined();
    expect(typeof result.runtimeViews?.getProcessTree).toBe("function");
    expect(typeof result.runtimeViews?.getAgentProcfs).toBe("function");
    expect(typeof result.runtimeViews?.getMiddlewareChain).toBe("function");
    expect(typeof result.runtimeViews?.getGatewayTopology).toBe("function");
  });

  test("getProcessTree returns single agent node", async () => {
    const opts = createTestOptions({
      agentName: "tree-agent",
      agentType: "worker",
    });
    const { runtimeViews, dataSource } = createAdminPanelBridge(opts);
    expect(runtimeViews).toBeDefined();
    const views = unwrap(runtimeViews, "runtimeViews");

    const tree = await views.getProcessTree();
    expect(tree.totalAgents).toBe(1);
    expect(tree.roots).toHaveLength(1);
    expect(typeof tree.timestamp).toBe("number");

    const root = first(tree.roots);
    expect(root.name).toBe("tree-agent");
    expect(root.agentType).toBe("worker");
    expect(root.state).toBe("running");
    expect(root.depth).toBe(0);
    expect(root.children).toEqual([]);

    // Verify agentId matches the primary agent
    const agents = await dataSource.listAgents();
    expect(root.agentId).toBe(first(agents).agentId);
  });

  test("getAgentProcfs returns data for primary agent", async () => {
    const opts = createTestOptions({
      agentName: "procfs-agent",
      agentType: "copilot",
      model: "anthropic:claude-sonnet-4-5-20250929",
      channels: ["cli", "slack"],
    });
    const result = createAdminPanelBridge(opts);
    const views = unwrap(result.runtimeViews, "runtimeViews");
    const { dataSource } = result;

    const agents = await dataSource.listAgents();
    const primaryId = first(agents).agentId;
    const procfs = await views.getAgentProcfs(primaryId);

    expect(procfs).toBeDefined();
    expect(procfs?.agentId).toBe(primaryId);
    expect(procfs?.name).toBe("procfs-agent");
    expect(procfs?.agentType).toBe("copilot");
    expect(procfs?.model).toBe("anthropic:claude-sonnet-4-5-20250929");
    expect(procfs?.channels).toEqual(["cli", "slack"]);
    expect(procfs?.turns).toBe(0);
    expect(procfs?.tokenCount).toBe(0);
    expect(typeof procfs?.startedAt).toBe("number");
    expect(typeof procfs?.lastActivityAt).toBe("number");
    expect(procfs?.childCount).toBe(0);
    expect(procfs?.parentId).toBeUndefined();
  });

  test("getAgentProcfs returns undefined for unknown ID", async () => {
    const { runtimeViews } = createAdminPanelBridge(createTestOptions());
    const views = unwrap(runtimeViews, "runtimeViews");

    const procfs = await views.getAgentProcfs(agentId("unknown-id"));
    expect(procfs).toBeUndefined();
  });

  test("getMiddlewareChain returns empty entries", async () => {
    const result = createAdminPanelBridge(createTestOptions());
    const views = unwrap(result.runtimeViews, "runtimeViews");
    const { dataSource } = result;

    const agents = await dataSource.listAgents();
    const chain = await views.getMiddlewareChain(first(agents).agentId);

    expect(chain.agentId).toBe(first(agents).agentId);
    expect(chain.entries).toEqual([]);
  });

  test("getGatewayTopology returns connected channels", async () => {
    const opts = createTestOptions({
      channels: ["cli", "telegram"],
    });
    const result = createAdminPanelBridge(opts);
    const views = unwrap(result.runtimeViews, "runtimeViews");
    const { dataSource } = result;

    const topology = await views.getGatewayTopology();
    expect(topology.connections).toHaveLength(2);
    expect(topology.nodeCount).toBe(2);
    expect(typeof topology.timestamp).toBe("number");

    const agents = await dataSource.listAgents();
    const primaryId = first(agents).agentId;

    const conn0 = first(topology.connections);
    expect(conn0.channelType).toBe("cli");
    expect(conn0.agentId).toBe(primaryId);
    expect(conn0.connected).toBe(true);
    expect(typeof conn0.connectedAt).toBe("number");

    const conn1 = topology.connections[1];
    expect(conn1).toBeDefined();
    expect(conn1?.channelType).toBe("telegram");
    expect(conn1?.agentId).toBe(primaryId);
    expect(conn1?.connected).toBe(true);
  });

  test("getGatewayTopology returns empty when no channels", async () => {
    const { runtimeViews } = createAdminPanelBridge(createTestOptions({ channels: [] }));
    const views = unwrap(runtimeViews, "runtimeViews");

    const topology = await views.getGatewayTopology();
    expect(topology.connections).toEqual([]);
    expect(topology.nodeCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // updateMetrics
  // ---------------------------------------------------------------------------

  test("updateMetrics updates agent summary turns", async () => {
    const result = createAdminPanelBridge(createTestOptions());
    result.updateMetrics({ turns: 5, totalTokens: 1200 });

    const agents = await result.dataSource.listAgents();
    expect(first(agents).turns).toBe(5);
  });

  test("updateMetrics updates agent detail tokenCount", async () => {
    const result = createAdminPanelBridge(createTestOptions());
    result.updateMetrics({ turns: 3, totalTokens: 800 });

    const agents = await result.dataSource.listAgents();
    const detail = await result.dataSource.getAgent(first(agents).agentId);
    expect(detail?.tokenCount).toBe(800);
  });

  test("updateMetrics updates procfs metrics", async () => {
    const result = createAdminPanelBridge(createTestOptions());
    const views = unwrap(result.runtimeViews, "runtimeViews");
    result.updateMetrics({ turns: 7, totalTokens: 2000 });

    const agents = await result.dataSource.listAgents();
    const procfs = await views.getAgentProcfs(first(agents).agentId);
    expect(procfs?.turns).toBe(7);
    expect(procfs?.tokenCount).toBe(2000);
  });

  // ---------------------------------------------------------------------------
  // Orchestration command SSE events
  // ---------------------------------------------------------------------------

  test("orchestration command emits SSE event on success", async () => {
    const pauseHarness = mock(
      async (): Promise<{ readonly ok: true; readonly value: undefined }> => ({
        ok: true,
        value: undefined,
      }),
    );
    const result = createAdminPanelBridge(
      createTestOptions({
        orchestrationCommands: {
          pauseHarness,
        },
      }),
    );

    const events: DashboardEvent[] = [];
    result.dataSource.subscribe((e) => events.push(e));

    const cmd = result.commands?.pauseHarness;
    if (cmd === undefined) throw new Error("expected pauseHarness command");
    const cmdResult = await cmd();
    expect(cmdResult.ok).toBe(true);
    expect(pauseHarness).toHaveBeenCalledTimes(1);

    const harnessEvents = events.filter((e) => e.kind === "harness");
    expect(harnessEvents).toHaveLength(1);
    expect(first(harnessEvents).subKind).toBe("phase_changed");
  });

  test("orchestration command does not emit event on failure", async () => {
    const pauseHarness = mock(
      async (): Promise<{
        readonly ok: false;
        readonly error: {
          readonly code: "CONFLICT";
          readonly message: string;
          readonly retryable: false;
        };
      }> => ({
        ok: false,
        error: { code: "CONFLICT", message: "already paused", retryable: false },
      }),
    );
    const result = createAdminPanelBridge(
      createTestOptions({
        orchestrationCommands: {
          pauseHarness,
        },
      }),
    );

    const events: DashboardEvent[] = [];
    result.dataSource.subscribe((e) => events.push(e));

    const cmd = result.commands?.pauseHarness;
    if (cmd === undefined) throw new Error("expected pauseHarness command");
    const cmdResult = await cmd();
    expect(cmdResult.ok).toBe(false);

    const harnessEvents = events.filter((e) => e.kind === "harness");
    expect(harnessEvents).toHaveLength(0);
  });

  test("terminateWorkflow emits temporal:workflow_completed event", async () => {
    const terminateWorkflow = mock(
      async (_id: string): Promise<{ readonly ok: true; readonly value: undefined }> => ({
        ok: true,
        value: undefined,
      }),
    );
    const result = createAdminPanelBridge(
      createTestOptions({
        orchestrationCommands: {
          terminateWorkflow,
        },
      }),
    );

    const events: DashboardEvent[] = [];
    result.dataSource.subscribe((e) => events.push(e));

    const cmd = result.commands?.terminateWorkflow;
    if (cmd === undefined) throw new Error("expected terminateWorkflow command");
    await cmd("wf-123");

    const temporalEvents = events.filter((e) => e.kind === "temporal");
    expect(temporalEvents).toHaveLength(1);
    expect(first(temporalEvents).subKind).toBe("workflow_completed");
  });

  test("updateMetrics emits metrics_updated event", () => {
    const result = createAdminPanelBridge(createTestOptions());

    const events: DashboardEvent[] = [];
    result.dataSource.subscribe((e) => events.push(e));

    result.updateMetrics({ turns: 1, totalTokens: 500 });

    expect(events).toHaveLength(1);
    expect(first(events).kind).toBe("agent");
    expect(first(events).subKind).toBe("metrics_updated");
  });

  test("commands.dispatchAgent is undefined when not provided", () => {
    const result = createAdminPanelBridge(createTestOptions());
    const cmds = result.commands;
    expect(cmds).toBeDefined();
    if (cmds === undefined) return;
    expect(cmds.dispatchAgent).toBeUndefined();
  });

  test("commands.dispatchAgent is wired when provided", async () => {
    const mockDispatch = mock(() =>
      Promise.resolve({
        ok: true as const,
        value: { agentId: agentId("test:dispatched:1"), name: "dispatched" },
      }),
    );
    const result = createAdminPanelBridge(createTestOptions({ dispatchAgent: mockDispatch }));
    const cmds = result.commands;
    expect(cmds).toBeDefined();
    if (cmds === undefined) return;

    expect(cmds.dispatchAgent).toBeDefined();

    const response = await cmds.dispatchAgent?.({ name: "dispatched" });
    expect(response?.ok).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Dispatched agent registration
  // ---------------------------------------------------------------------------

  test("registerDispatchedAgent is a function", () => {
    const result = createAdminPanelBridge(createTestOptions());
    expect(typeof result.registerDispatchedAgent).toBe("function");
  });

  test("registerDispatchedAgent makes agent appear in listAgents", async () => {
    const result = createAdminPanelBridge(createTestOptions());

    // Before registration: only primary agent
    const before = await result.dataSource.listAgents();
    expect(before).toHaveLength(1);

    // Register a dispatched agent
    result.registerDispatchedAgent({
      agentId: agentId("dispatched:agent:1"),
      name: "dispatched-1",
      agentType: "worker",
      startedAt: Date.now(),
    });

    // After registration: primary + dispatched
    const after = await result.dataSource.listAgents();
    expect(after).toHaveLength(2);
    const dispatched = after.find((a) => a.name === "dispatched-1");
    expect(dispatched).toBeDefined();
    expect(dispatched?.agentType).toBe("worker");
    expect(dispatched?.state).toBe("running");
  });

  test("registerDispatchedAgent makes agent appear in getAgent", async () => {
    const result = createAdminPanelBridge(createTestOptions());
    const dId = agentId("dispatched:agent:2");

    result.registerDispatchedAgent({
      agentId: dId,
      name: "dispatched-2",
      agentType: "copilot",
      model: "anthropic:test",
      startedAt: Date.now(),
    });

    const detail = await result.dataSource.getAgent(dId);
    expect(detail).toBeDefined();
    expect(detail?.name).toBe("dispatched-2");
    expect(detail?.agentType).toBe("copilot");
  });

  test("dispatched agents are included in system metrics", async () => {
    const result = createAdminPanelBridge(createTestOptions());

    result.registerDispatchedAgent({
      agentId: agentId("dispatched:metrics:1"),
      name: "metrics-test",
      agentType: "worker",
      startedAt: Date.now(),
    });

    const metrics = await result.dataSource.getSystemMetrics();
    expect(metrics.activeAgents).toBe(2);
    expect(metrics.totalAgents).toBe(2);
  });

  test("terminateAgent works for dispatched agents", async () => {
    const result = createAdminPanelBridge(createTestOptions());
    const dId = agentId("dispatched:term:1");

    result.registerDispatchedAgent({
      agentId: dId,
      name: "terminate-me",
      agentType: "worker",
      startedAt: Date.now(),
    });

    const termResult = await result.dataSource.terminateAgent(dId);
    expect(termResult.ok).toBe(true);

    const detail = await result.dataSource.getAgent(dId);
    expect(detail?.state).toBe("terminated");
  });

  test("wrappedDispatchAgent auto-registers and emits dispatched event", async () => {
    const dId = agentId("auto:reg:1");
    const mockDispatch = mock(() =>
      Promise.resolve({
        ok: true as const,
        value: { agentId: dId, name: "auto-registered" },
      }),
    );
    const result = createAdminPanelBridge(createTestOptions({ dispatchAgent: mockDispatch }));

    const events: DashboardEvent[] = [];
    result.dataSource.subscribe((e) => events.push(e));

    await result.commands?.dispatchAgent?.({ name: "auto-registered" });

    // Should auto-register in data source
    const agents = await result.dataSource.listAgents();
    expect(agents.some((a) => a.name === "auto-registered")).toBe(true);

    // Should emit dispatched event
    const dispatched = events.filter((e) => e.kind === "agent" && e.subKind === "dispatched");
    expect(dispatched).toHaveLength(1);
  });
});
