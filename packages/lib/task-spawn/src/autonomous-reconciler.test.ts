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
    expect(result.actions).toMatchObject([
      { kind: "dispatch", taskId: taskItemId("c"), agentType: "researcher" },
      { kind: "dispatch", taskId: taskItemId("b"), agentType: "coder" },
    ]);
    for (const action of result.actions) {
      if (action.kind === "dispatch") {
        expect(typeof action.version).toBe("number");
      }
    }
  });

  test("stale delegations are cleared and immediately redispatched in the same pass", () => {
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

    const result = reconcileTaskBoard(serializeBoard(board.value), {
      isDelegationStale: () => true,
    });
    expect(result.actions).toMatchObject([
      { kind: "clearDelegation", taskId: taskItemId("stale"), delegatedTo: "worker-1" },
      { kind: "dispatch", taskId: taskItemId("stale"), agentType: "reviewer" },
    ]);
  });

  test("does not clear active delegations without a staleness signal", () => {
    const board = createTaskBoard().add({
      id: taskItemId("live"),
      subject: "in flight",
      description: "currently being worked",
      metadata: {
        delegation: "spawn",
        agentType: "reviewer",
        delegatedTo: "worker-1",
      },
    });
    if (!board.ok) throw board.error;

    const result = reconcileTaskBoard(serializeBoard(board.value));
    expect(result.actions).toEqual([]);
  });

  test("emits cancelDownstream for descendants of failed and killed tasks", () => {
    const board = createTaskBoard().addAll([
      {
        id: taskItemId("root"),
        subject: "broken root",
        description: "fails",
      },
      {
        id: taskItemId("child"),
        subject: "blocked child",
        description: "depends on root",
        dependencies: [taskItemId("root")],
        metadata: { delegation: "spawn", agentType: "coder" },
      },
      {
        id: taskItemId("grandchild"),
        subject: "blocked grandchild",
        description: "depends on child",
        dependencies: [taskItemId("child")],
        metadata: { delegation: "spawn", agentType: "coder" },
      },
    ]);
    if (!board.ok) throw board.error;

    const assigned = board.value.assign(taskItemId("root"), agentId("worker-1"));
    if (!assigned.ok) throw assigned.error;
    const failed = assigned.value.fail(taskItemId("root"), {
      code: "EXTERNAL",
      message: "boom",
      retryable: false,
    });
    if (!failed.ok) throw failed.error;

    const result = reconcileTaskBoard(serializeBoard(failed.value));
    expect(result.actions).toEqual([
      {
        kind: "cancelDownstream",
        taskId: taskItemId("child"),
        blockedBy: taskItemId("root"),
        reason: "upstream-failed",
      },
      {
        kind: "cancelDownstream",
        taskId: taskItemId("grandchild"),
        blockedBy: taskItemId("root"),
        reason: "upstream-failed",
      },
    ]);
  });

  test("propagates the killed-ancestor reason through transitive descendants", () => {
    const board = createTaskBoard().addAll([
      {
        id: taskItemId("root"),
        subject: "killed root",
        description: "killed by operator",
      },
      {
        id: taskItemId("child"),
        subject: "blocked child",
        description: "depends on root",
        dependencies: [taskItemId("root")],
      },
      {
        id: taskItemId("grandchild"),
        subject: "blocked grandchild",
        description: "depends on child",
        dependencies: [taskItemId("child")],
      },
    ]);
    if (!board.ok) throw board.error;

    const killed = board.value.kill(taskItemId("root"));
    if (!killed.ok) throw killed.error;

    const result = reconcileTaskBoard(serializeBoard(killed.value));
    expect(result.actions).toEqual([
      {
        kind: "cancelDownstream",
        taskId: taskItemId("child"),
        blockedBy: taskItemId("root"),
        reason: "upstream-killed",
      },
      {
        kind: "cancelDownstream",
        taskId: taskItemId("grandchild"),
        blockedBy: taskItemId("root"),
        reason: "upstream-killed",
      },
    ]);
  });

  test("clears malformed delegatedTo markers without a staleness predicate", () => {
    const board = createTaskBoard().addAll([
      {
        id: taskItemId("empty"),
        subject: "empty marker",
        description: "delegatedTo is empty string",
        metadata: { delegation: "spawn", agentType: "reviewer", delegatedTo: "" },
      },
      {
        id: taskItemId("numeric"),
        subject: "numeric marker",
        description: "delegatedTo is number",
        metadata: {
          delegation: "spawn",
          agentType: "reviewer",
          delegatedTo: 42 as unknown as string,
        },
      },
      {
        id: taskItemId("nullish"),
        subject: "null marker",
        description: "delegatedTo is null",
        metadata: {
          delegation: "spawn",
          agentType: "reviewer",
          delegatedTo: null as unknown as string,
        },
      },
    ]);
    if (!board.ok) throw board.error;

    const result = reconcileTaskBoard(serializeBoard(board.value));
    const cleared = result.actions.filter((action) => action.kind === "clearDelegation");
    expect(cleared.map((action) => action.taskId).sort()).toEqual([
      taskItemId("empty"),
      taskItemId("nullish"),
      taskItemId("numeric"),
    ]);
  });

  test("isDelegationStale predicate decides per-task whether to recover", () => {
    const board = createTaskBoard().addAll([
      {
        id: taskItemId("alive"),
        subject: "still working",
        description: "active worker",
        metadata: {
          delegation: "spawn",
          agentType: "reviewer",
          delegatedTo: "worker-alive",
        },
      },
      {
        id: taskItemId("dead"),
        subject: "abandoned",
        description: "worker died",
        metadata: {
          delegation: "spawn",
          agentType: "reviewer",
          delegatedTo: "worker-dead",
        },
      },
    ]);
    if (!board.ok) throw board.error;

    const result = reconcileTaskBoard(serializeBoard(board.value), {
      isDelegationStale: (_task, delegatedTo) => delegatedTo === "worker-dead",
    });
    expect(result.actions).toMatchObject([
      { kind: "clearDelegation", taskId: taskItemId("dead"), delegatedTo: "worker-dead" },
      { kind: "dispatch", taskId: taskItemId("dead"), agentType: "reviewer" },
    ]);
  });

  test("dispatch actions include the task version as an OCC token", () => {
    const board = createTaskBoard().add({
      id: taskItemId("ready"),
      subject: "ready to dispatch",
      description: "ready",
      metadata: { delegation: "spawn", agentType: "researcher" },
    });
    if (!board.ok) throw board.error;

    const snapshot = serializeBoard(board.value);
    const taskVersion = snapshot.items.find((t) => t.id === taskItemId("ready"))?.version;
    expect(typeof taskVersion).toBe("number");

    const result = reconcileTaskBoard(snapshot);
    const dispatch = result.actions.find((a) => a.kind === "dispatch");
    if (dispatch?.kind !== "dispatch") throw new Error("expected dispatch action");
    expect(dispatch.version).toBe(taskVersion as number);
  });
});
