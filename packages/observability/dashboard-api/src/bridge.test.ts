/**
 * Tests for createAdminPanelBridge — adapts live runtime state into
 * DashboardDataSource for the admin panel.
 */

import { describe, expect, test } from "bun:test";
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

    const agent = agents[0];
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
    const detail = await dataSource.getAgent(agents[0].agentId);

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
    const result = await dataSource.terminateAgent(agents[0].agentId);
    expect(result.ok).toBe(true);
  });

  test("listChannels returns configured channels", async () => {
    const opts = createTestOptions({
      channels: ["cli", "telegram", "slack"],
    });
    const { dataSource } = createAdminPanelBridge(opts);

    const channels = await dataSource.listChannels();
    expect(channels).toHaveLength(3);
    expect(channels[0].channelType).toBe("cli");
    expect(channels[1].channelType).toBe("telegram");
    expect(channels[2].channelType).toBe("slack");
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
    expect(skills[0].name).toBe("web-search");
    expect(skills[1].name).toBe("code-review");
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
    expect(events[0].kind).toBe("system");
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
    const id = agents[0].agentId;

    await dataSource.terminateAgent(id);

    const agentsAfter = await dataSource.listAgents();
    expect(agentsAfter[0].state).toBe("terminated");

    const detail = await dataSource.getAgent(id);
    expect(detail?.state).toBe("terminated");
  });

  test("terminateAgent on already terminated agent returns error", async () => {
    const { dataSource } = createAdminPanelBridge(createTestOptions());

    const agents = await dataSource.listAgents();
    const id = agents[0].agentId;

    // First termination succeeds
    const first = await dataSource.terminateAgent(id);
    expect(first.ok).toBe(true);

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
    await result.dataSource.terminateAgent(agents[0].agentId);

    expect(events.some((e) => e.kind === "agent" && e.subKind === "status_changed")).toBe(true);
  });

  test("gracefully handles empty channels and skills arrays", async () => {
    const { dataSource } = createAdminPanelBridge(createTestOptions({ channels: [], skills: [] }));

    const channels = await dataSource.listChannels();
    const skills = await dataSource.listSkills();
    expect(channels).toEqual([]);
    expect(skills).toEqual([]);
  });
});
