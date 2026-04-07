import { describe, expect, test } from "bun:test";
import { taskItemId } from "@koi/core";
import { createOutputStream } from "./output-stream.js";
import {
  type DreamTask,
  type InProcessTeammateTask,
  type LocalAgentTask,
  type LocalShellTask,
  type RemoteAgentTask,
  isDreamTask,
  isInProcessTeammateTask,
  isLocalAgentTask,
  isLocalShellTask,
  isRemoteAgentTask,
  isRuntimeTask,
} from "./task-kinds.js";

/** Helper to build a base runtime task for testing. */
function makeBase(kind: string) {
  return {
    kind,
    taskId: taskItemId("task_1"),
    cancel: () => {},
    output: createOutputStream(),
    startedAt: Date.now(),
  };
}

describe("task kind type guards", () => {
  test("isLocalShellTask identifies local_shell kind", () => {
    const task: LocalShellTask = {
      ...makeBase("local_shell"),
      kind: "local_shell" as const,
      command: "echo hello",
    };
    expect(isLocalShellTask(task)).toBe(true);
    expect(isLocalAgentTask(task)).toBe(false);
    expect(isRuntimeTask(task)).toBe(true);
  });

  test("isLocalAgentTask identifies local_agent kind", () => {
    const task: LocalAgentTask = {
      ...makeBase("local_agent"),
      kind: "local_agent" as const,
      agentType: "researcher",
    };
    expect(isLocalAgentTask(task)).toBe(true);
    expect(isLocalShellTask(task)).toBe(false);
  });

  test("isRemoteAgentTask identifies remote_agent kind", () => {
    const task: RemoteAgentTask = {
      ...makeBase("remote_agent"),
      kind: "remote_agent" as const,
      endpoint: "https://example.com",
      correlationId: "corr-123",
    };
    expect(isRemoteAgentTask(task)).toBe(true);
  });

  test("isInProcessTeammateTask identifies in_process_teammate kind", () => {
    const task: InProcessTeammateTask = {
      ...makeBase("in_process_teammate"),
      kind: "in_process_teammate" as const,
      identity: {
        agentId: "researcher@team",
        agentName: "researcher",
        teamName: "team",
        planModeRequired: true,
      },
      planApprovalState: () => ({ awaiting: false }),
    };
    expect(isInProcessTeammateTask(task)).toBe(true);
  });

  test("isDreamTask identifies dream kind", () => {
    const task: DreamTask = {
      ...makeBase("dream"),
      kind: "dream" as const,
    };
    expect(isDreamTask(task)).toBe(true);
  });

  test("isRuntimeTask rejects non-task objects", () => {
    expect(isRuntimeTask(null)).toBe(false);
    expect(isRuntimeTask({})).toBe(false);
    expect(isRuntimeTask({ kind: "unknown" })).toBe(false);
  });

  test("PlanApprovalSnapshot is immutable snapshot", () => {
    const task: InProcessTeammateTask = {
      ...makeBase("in_process_teammate"),
      kind: "in_process_teammate" as const,
      identity: {
        agentId: "a@t",
        agentName: "a",
        teamName: "t",
        planModeRequired: false,
      },
      planApprovalState: () => ({ awaiting: true, requestedAt: 1000 }),
    };

    const snapshot = task.planApprovalState();
    expect(snapshot.awaiting).toBe(true);
    expect(snapshot.requestedAt).toBe(1000);
  });
});
