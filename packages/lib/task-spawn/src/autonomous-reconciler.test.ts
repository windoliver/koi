import { describe, expect, test } from "bun:test";
import { agentId, taskItemId } from "@koi/core";
import { createTaskBoard, serializeBoard } from "@koi/task-board";
import { reconcileTaskBoard } from "./autonomous-reconciler.js";

describe("reconcileTaskBoard", () => {
  test("blocked tasks are not dispatched", () => {
    const board = createTaskBoard().addAll([
      {
        id: taskItemId("a"),
        subject: "parent",
        description: "complete parent first",
      },
      {
        id: taskItemId("b"),
        subject: "child",
        description: "spawn child after parent completes",
        dependencies: [taskItemId("a")],
        metadata: { delegation: "spawn", agentType: "researcher" },
      },
    ]);
    if (!board.ok) throw board.error;

    const result = reconcileTaskBoard(serializeBoard(board.value));
    expect(result.actions).toEqual([]);
  });

  test("ready spawn tasks are emitted in topological order", () => {
    const board = createTaskBoard().addAll([
      {
        id: taskItemId("a"),
        subject: "root",
        description: "complete prerequisite",
      },
      {
        id: taskItemId("b"),
        subject: "dependent-worker",
        description: "dispatch only after root completes",
        dependencies: [taskItemId("a")],
        metadata: { delegation: "spawn", agentType: "coder" },
      },
      {
        id: taskItemId("c"),
        subject: "independent-worker",
        description: "dispatch immediately once reconciliation runs",
        metadata: { delegation: "spawn", agentType: "researcher" },
      },
    ]);
    if (!board.ok) throw board.error;

    const assigned = board.value.assign(taskItemId("a"), agentId("worker-1"));
    if (!assigned.ok) throw assigned.error;

    const completed = assigned.value.complete(taskItemId("a"), {
      taskId: taskItemId("a"),
      output: "done",
      durationMs: 10,
    });
    if (!completed.ok) throw completed.error;

    const result = reconcileTaskBoard(serializeBoard(completed.value));
    expect(result.actions).toEqual([
      { kind: "dispatch", taskId: taskItemId("c"), agentType: "researcher" },
      { kind: "dispatch", taskId: taskItemId("b"), agentType: "coder" },
    ]);
  });

  test("stale metadata.delegatedTo on pending tasks emits a recovery action", () => {
    const board = createTaskBoard().add({
      id: taskItemId("stale"),
      subject: "recover me",
      description: "clear the stale delegation marker",
      metadata: {
        delegation: "spawn",
        agentType: "reviewer",
        delegatedTo: "worker-1",
      },
    });
    if (!board.ok) throw board.error;

    const result = reconcileTaskBoard(serializeBoard(board.value));
    expect(result.actions).toEqual([
      { kind: "clearDelegation", taskId: taskItemId("stale"), delegatedTo: "worker-1" },
    ]);
  });
});
