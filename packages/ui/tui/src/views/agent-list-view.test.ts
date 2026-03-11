import { describe, expect, test } from "bun:test";
import type { AgentId, ProcessState } from "@koi/core";
import type { DashboardAgentSummary } from "@koi/dashboard-types";
import { createAgentListView } from "./agent-list-view.js";

function makeAgent(overrides: Partial<DashboardAgentSummary> = {}): DashboardAgentSummary {
  return {
    agentId: "a1" as AgentId,
    name: "test-agent",
    agentType: "copilot",
    state: "running" as ProcessState,
    channels: [],
    turns: 5,
    startedAt: Date.now() - 60_000,
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

describe("createAgentListView", () => {
  test("creates component and update function", () => {
    const view = createAgentListView({
      onSelect: () => {},
      onCancel: () => {},
    });
    expect(view.component).toBeDefined();
    expect(typeof view.update).toBe("function");
  });

  test("renders empty state", () => {
    const view = createAgentListView({
      onSelect: () => {},
      onCancel: () => {},
    });
    view.update([]);
    const lines = view.component.render(80);
    expect(lines.length).toBeGreaterThan(0);
  });

  test("renders agent list", () => {
    const view = createAgentListView({
      onSelect: () => {},
      onCancel: () => {},
    });
    const agents = [
      makeAgent({ agentId: "a1" as AgentId, name: "alpha" }),
      makeAgent({ agentId: "a2" as AgentId, name: "beta", state: "suspended" as ProcessState }),
    ];
    view.update(agents);
    const lines = view.component.render(80);
    expect(lines.length).toBeGreaterThan(0);
  });

  test("calls onSelect when agent is selected", () => {
    let selectedId: string | undefined;
    const view = createAgentListView({
      onSelect: (id) => {
        selectedId = id;
      },
      onCancel: () => {},
    });
    const agents = [makeAgent({ agentId: "a1" as AgentId, name: "alpha" })];
    view.update(agents);

    // Simulate selection via the SelectList callback
    const item = view.component.getSelectedItem();
    if (item !== null) {
      view.component.onSelect?.(item);
    }
    expect(selectedId).toBe("a1");
  });
});
