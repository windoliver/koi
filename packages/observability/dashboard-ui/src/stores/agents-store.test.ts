import { beforeEach, describe, expect, test } from "bun:test";
import type { DashboardAgentSummary } from "@koi/dashboard-types";
import { useAgentsStore } from "./agents-store.js";

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
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

describe("agents-store", () => {
  beforeEach(() => {
    useAgentsStore.setState({
      agents: {},
      lastFullRefresh: 0,
      isLoading: true,
      initialLoadDone: false,
      error: null,
    });
  });

  test("setAgents populates store from array", () => {
    const { setAgents } = useAgentsStore.getState();
    const fetchStartedAt = Date.now();
    setAgents([makeSummary("a1"), makeSummary("a2")], fetchStartedAt);

    const state = useAgentsStore.getState();
    expect(Object.keys(state.agents)).toHaveLength(2);
    expect(state.agents.a1?.name).toBe("agent-a1");
    expect(state.lastFullRefresh).toBeGreaterThan(0);
    expect(state.initialLoadDone).toBe(true);
    expect(state.error).toBeNull();
  });

  test("setAgents rejects stale full refresh", () => {
    const { setAgents } = useAgentsStore.getState();
    // First refresh at T=100
    setAgents([makeSummary("a1")], 100);
    const afterFirst = useAgentsStore.getState().lastFullRefresh;

    // Stale refresh started at T=50 (before first completed)
    setAgents([makeSummary("a1"), makeSummary("a2")], 50);

    // Should still have only the first refresh's data
    expect(Object.keys(useAgentsStore.getState().agents)).toHaveLength(1);
    expect(useAgentsStore.getState().lastFullRefresh).toBe(afterFirst);
  });

  test("setAgents is NOT blocked by SSE mutations", () => {
    const { setAgents, updateAgent } = useAgentsStore.getState();
    const fetchStartedAt = Date.now();
    setAgents([makeSummary("a1", { state: "running" })], fetchStartedAt);

    // SSE mutation arrives while a new fetch is in flight
    updateAgent("a1", { state: "waiting" });

    // A newer full refresh should still apply (not be rejected)
    const newerFetchStartedAt = Date.now();
    setAgents([makeSummary("a1", { state: "running" }), makeSummary("a2")], newerFetchStartedAt);

    const state = useAgentsStore.getState();
    expect(Object.keys(state.agents)).toHaveLength(2);
  });

  test("updateAgent merges partial update", () => {
    const { setAgents, updateAgent } = useAgentsStore.getState();
    setAgents([makeSummary("a1")], Date.now());

    updateAgent("a1", { state: "waiting", turns: 5 });

    const agent = useAgentsStore.getState().agents.a1;
    expect(agent?.state).toBe("waiting");
    expect(agent?.turns).toBe(5);
    expect(agent?.name).toBe("agent-a1"); // unchanged
  });

  test("updateAgent ignores unknown agent", () => {
    const { updateAgent } = useAgentsStore.getState();
    updateAgent("unknown", { state: "terminated" });

    expect(useAgentsStore.getState().agents.unknown).toBeUndefined();
  });

  test("removeAgent removes agent from store", () => {
    const { setAgents, removeAgent } = useAgentsStore.getState();
    setAgents([makeSummary("a1"), makeSummary("a2")], Date.now());

    removeAgent("a1");

    const state = useAgentsStore.getState();
    expect(state.agents.a1).toBeUndefined();
    expect(state.agents.a2).toBeDefined();
  });

  test("setAgents clears error", () => {
    useAgentsStore.setState({ error: new Error("test") });

    const { setAgents } = useAgentsStore.getState();
    setAgents([makeSummary("a1")], Date.now());

    expect(useAgentsStore.getState().error).toBeNull();
  });

  test("initialLoadDone persists after empty fetch", () => {
    const { setAgents } = useAgentsStore.getState();
    setAgents([], Date.now());

    const state = useAgentsStore.getState();
    expect(state.initialLoadDone).toBe(true);
    expect(Object.keys(state.agents)).toHaveLength(0);
  });
});
