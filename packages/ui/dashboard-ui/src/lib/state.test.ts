import { describe, expect, test } from "bun:test";
import { demoDashboardData } from "./demo-data.js";
import { applyDashboardEvent, createDashboardViewModel } from "./state.js";

describe("createDashboardViewModel", () => {
  test("selects the first agent and its latest session by default", () => {
    const viewModel = createDashboardViewModel(demoDashboardData);

    expect(viewModel.selectedAgentId).toBe("agent-orchid");
    expect(viewModel.selectedSessionId).toBe("session-orchid-2");
    expect(viewModel.visibleSessions.map((session) => session.id)).toEqual([
      "session-orchid-2",
      "session-orchid-1",
    ]);
  });
});

describe("applyDashboardEvent", () => {
  test("switches the visible session list when another agent is selected", () => {
    const initialState = createDashboardViewModel(demoDashboardData);

    const nextState = applyDashboardEvent(initialState, {
      type: "agent.selected",
      agentId: "agent-lumen",
    });

    expect(nextState.selectedAgentId).toBe("agent-lumen");
    expect(nextState.selectedSessionId).toBe("session-lumen-1");
    expect(nextState.visibleSessions.map((session) => session.id)).toEqual(["session-lumen-1"]);
  });

  test("syncs the selected agent when a session is chosen directly", () => {
    const initialState = createDashboardViewModel(demoDashboardData);

    const nextState = applyDashboardEvent(initialState, {
      type: "session.selected",
      sessionId: "session-sable-1",
    });

    expect(nextState.selectedAgentId).toBe("agent-sable");
    expect(nextState.selectedSessionId).toBe("session-sable-1");
    expect(nextState.selectedSession?.title).toContain("Nightly");
  });

  test("tracks loading and error states locally", () => {
    const initialState = createDashboardViewModel(demoDashboardData);

    const loadingState = applyDashboardEvent(initialState, {
      type: "loading.set",
      isLoading: true,
    });
    const errorState = applyDashboardEvent(loadingState, {
      type: "error.set",
      message: "Unable to refresh demo data.",
    });

    expect(loadingState.isLoading).toBe(true);
    expect(errorState.errorMessage).toBe("Unable to refresh demo data.");
  });

  test("ignores unknown selections", () => {
    const initialState = createDashboardViewModel(demoDashboardData);

    const unknownAgentState = applyDashboardEvent(initialState, {
      type: "agent.selected",
      agentId: "agent-missing",
    });
    const unknownSessionState = applyDashboardEvent(initialState, {
      type: "session.selected",
      sessionId: "session-missing",
    });

    expect(unknownAgentState).toBe(initialState);
    expect(unknownSessionState).toBe(initialState);
  });
});
