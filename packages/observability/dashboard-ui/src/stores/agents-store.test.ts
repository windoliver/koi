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
    useAgentsStore.setState({ agents: {}, lastUpdated: 0 });
  });

  test("setAgents populates store from array", () => {
    const { setAgents } = useAgentsStore.getState();
    setAgents([makeSummary("a1"), makeSummary("a2")]);

    const state = useAgentsStore.getState();
    expect(Object.keys(state.agents)).toHaveLength(2);
    expect(state.agents.a1?.name).toBe("agent-a1");
    expect(state.lastUpdated).toBeGreaterThan(0);
  });

  test("updateAgent merges partial update", () => {
    const { setAgents, updateAgent } = useAgentsStore.getState();
    setAgents([makeSummary("a1")]);

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
    setAgents([makeSummary("a1"), makeSummary("a2")]);

    removeAgent("a1");

    const state = useAgentsStore.getState();
    expect(state.agents.a1).toBeUndefined();
    expect(state.agents.a2).toBeDefined();
  });
});
