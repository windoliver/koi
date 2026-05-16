import { expect, test } from "bun:test";
import {
  findInProcessTeammateTaskId,
  handlePlanApprovalResponse,
  isPlanModeRequired,
  setAwaitingPlanApproval,
} from "./plan-approval.js";

test("finds an in-process teammate task by agent name", () => {
  const appState = {
    tasks: {
      one: {
        id: "one",
        type: "in_process_teammate",
        identity: { agentName: "researcher" },
        awaitingPlanApproval: false,
      },
      two: { id: "two", type: "other", identity: { agentName: "researcher" } },
    },
  };

  expect(findInProcessTeammateTaskId("researcher", appState)).toBe("one");
  expect(findInProcessTeammateTaskId("coder", appState)).toBeUndefined();
});

test("sets and clears awaitingPlanApproval through app-state updater", () => {
  let appState = {
    tasks: {
      task_a: {
        id: "task_a",
        type: "in_process_teammate",
        identity: { agentName: "planner" },
        awaitingPlanApproval: false,
      },
    },
  };
  const setAppState = (updater: (prev: typeof appState) => typeof appState): void => {
    appState = updater(appState);
  };

  setAwaitingPlanApproval("task_a", setAppState, true);
  expect(appState.tasks.task_a.awaitingPlanApproval).toBe(true);

  handlePlanApprovalResponse(
    "task_a",
    {
      type: "plan_approval_response",
      requestId: "req-1",
      approved: true,
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    setAppState,
  );
  expect(appState.tasks.task_a.awaitingPlanApproval).toBe(false);
});

test("reads plan-mode requirement from teammate config", () => {
  expect(isPlanModeRequired({ role: "teammate", planModeRequired: true })).toBe(true);
  expect(isPlanModeRequired({ role: "teammate" })).toBe(false);
  expect(isPlanModeRequired({ role: "lead", planModeRequired: true })).toBe(false);
});
