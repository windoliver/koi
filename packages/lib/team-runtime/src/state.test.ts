import { expect, test } from "bun:test";
import { reduceTeamEvents } from "./state.js";

test("materializes added tasks into board-like snapshot order", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_1",
      timestamp: 1,
      payload: { specName: "refactor-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_1",
      timestamp: 2,
      taskId: "task_a",
      payload: {
        subject: "Find callsites",
        description: "Locate symbol usages",
        dependencies: [],
        targetAgentType: "researcher",
      },
    },
  ]);

  expect(snapshot.teamRunId).toBe("run_1");
  expect(snapshot.board.all()).toHaveLength(1);
  expect(snapshot.board.ready().map((task) => task.taskId)).toEqual(["task_a"]);
  expect(snapshot.board.get("task_a")?.targetAgentType).toBe("researcher");
});

test("evaluates dependency readiness and accepts exact duplicate adds", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_dep",
      timestamp: 1,
      payload: { specName: "dependency-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_dep",
      timestamp: 2,
      taskId: "task_a",
      payload: {
        subject: "Parent task",
        description: "Complete parent work",
        dependencies: [],
      },
    },
    {
      kind: "task.added",
      eventId: "e3",
      teamRunId: "run_dep",
      timestamp: 3,
      taskId: "task_b",
      payload: {
        subject: "Child task",
        description: "Wait for parent work",
        dependencies: ["task_a"],
      },
    },
    {
      kind: "task.added",
      eventId: "e4",
      teamRunId: "run_dep",
      timestamp: 4,
      taskId: "task_b",
      payload: {
        subject: "Child task",
        description: "Wait for parent work",
        dependencies: ["task_a"],
      },
    },
    {
      kind: "task.assigned",
      eventId: "e5",
      teamRunId: "run_dep",
      timestamp: 5,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
    {
      kind: "task.completed",
      eventId: "e6",
      teamRunId: "run_dep",
      timestamp: 6,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { output: "done" },
    },
  ]);

  expect(snapshot.board.all()).toHaveLength(2);
  expect(snapshot.board.get("missing_task")).toBeUndefined();
  expect(snapshot.board.ready().map((task) => task.taskId)).toEqual(["task_b"]);
});

test("replays assignment and completion into runtime snapshot", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_2",
      timestamp: 1,
      payload: { specName: "lint-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_2",
      timestamp: 2,
      taskId: "task_a",
      payload: {
        subject: "Fix lint",
        description: "Fix lint in pkg a",
        dependencies: [],
      },
    },
    {
      kind: "task.assigned",
      eventId: "e3",
      teamRunId: "run_2",
      timestamp: 3,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
    {
      kind: "task.completed",
      eventId: "e4",
      teamRunId: "run_2",
      timestamp: 4,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { output: "done" },
    },
  ]);

  expect(snapshot.board.get("task_a")?.status).toBe("completed");
  expect(snapshot.outputs.get("task_a")).toBe("done");
});

test("requeues orphaned in-progress work after crash detection event", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_crash",
      timestamp: 1,
      payload: { specName: "crash-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_crash",
      timestamp: 2,
      taskId: "task_a",
      payload: {
        subject: "A",
        description: "A",
        dependencies: [],
      },
    },
    {
      kind: "task.assigned",
      eventId: "e3",
      teamRunId: "run_crash",
      timestamp: 3,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
    {
      kind: "task.crash_detected",
      eventId: "e4",
      teamRunId: "run_crash",
      timestamp: 4,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
  ]);

  expect(snapshot.board.get("task_a")?.status).toBe("pending");
  expect(snapshot.board.ready().map((task) => task.taskId)).toEqual(["task_a"]);
  expect(snapshot.activeAssignments.has("task_a")).toBe(false);
});

test("does not expose mutable map APIs on snapshot outputs or assignments", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_ro",
      timestamp: 1,
      payload: { specName: "readonly-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_ro",
      timestamp: 2,
      taskId: "task_a",
      payload: {
        subject: "Ship patch",
        description: "Land the runtime fix",
        dependencies: [],
      },
    },
    {
      kind: "task.assigned",
      eventId: "e3",
      teamRunId: "run_ro",
      timestamp: 3,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
    {
      kind: "task.completed",
      eventId: "e4",
      teamRunId: "run_ro",
      timestamp: 4,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { output: "done" },
    },
  ]);

  const outputs = snapshot.outputs as unknown as Record<string, unknown>;
  const activeAssignments = snapshot.activeAssignments as unknown as Record<string, unknown>;
  const seenOutputs: Array<[string, string]> = [];
  const seenAssignments: Array<[string, string]> = [];

  expect(snapshot.outputs.get("task_a")).toBe("done");
  expect(snapshot.activeAssignments.has("task_a")).toBe(false);
  expect(snapshot.outputs.size).toBe(1);
  expect(snapshot.activeAssignments.size).toBe(0);
  snapshot.outputs.forEach((value, key) => {
    seenOutputs.push([key, value]);
  });
  snapshot.activeAssignments.forEach((value, key) => {
    seenAssignments.push([key, value]);
  });
  expect(seenOutputs).toEqual([["task_a", "done"]]);
  expect(seenAssignments).toEqual([]);
  expect([...snapshot.outputs]).toEqual([["task_a", "done"]]);
  expect([...snapshot.outputs.entries()]).toEqual([["task_a", "done"]]);
  expect([...snapshot.outputs.keys()]).toEqual(["task_a"]);
  expect([...snapshot.outputs.values()]).toEqual(["done"]);
  expect([...snapshot.activeAssignments]).toEqual([]);
  expect([...snapshot.activeAssignments.entries()]).toEqual([]);
  expect([...snapshot.activeAssignments.keys()]).toEqual([]);
  expect([...snapshot.activeAssignments.values()]).toEqual([]);
  expect(outputs.set).toBeUndefined();
  expect(outputs.delete).toBeUndefined();
  expect(outputs.clear).toBeUndefined();
  expect(activeAssignments.set).toBeUndefined();
  expect(activeAssignments.delete).toBeUndefined();
  expect(activeAssignments.clear).toBeUndefined();
});

test("rejects mixed teamRunId event streams", () => {
  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_1",
        timestamp: 1,
        payload: { specName: "refactor-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_2",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Find callsites",
          description: "Locate symbol usages",
          dependencies: [],
        },
      },
    ]),
  ).toThrow(/mixed teamRunId/i);
});

test("ignores duplicate task.added replay after completion", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_3",
      timestamp: 1,
      payload: { specName: "delivery-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_3",
      timestamp: 2,
      taskId: "task_a",
      payload: {
        subject: "Ship patch",
        description: "Land the runtime fix",
        dependencies: [],
      },
    },
    {
      kind: "task.assigned",
      eventId: "e3",
      teamRunId: "run_3",
      timestamp: 3,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
    {
      kind: "task.completed",
      eventId: "e4",
      teamRunId: "run_3",
      timestamp: 4,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { output: "done" },
    },
    {
      kind: "task.added",
      eventId: "e5",
      teamRunId: "run_3",
      timestamp: 5,
      taskId: "task_a",
      payload: {
        subject: "Ship patch",
        description: "Land the runtime fix",
        dependencies: [],
      },
    },
  ]);

  expect(snapshot.board.all()).toHaveLength(1);
  expect(snapshot.board.get("task_a")).toMatchObject({
    taskId: "task_a",
    status: "completed",
    assignedAgentId: "coder-1",
  });
  expect(snapshot.outputs.get("task_a")).toBe("done");
  expect(snapshot.activeAssignments.has("task_a")).toBe(false);
});

test("rejects conflicting duplicate task.added replay", () => {
  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_4",
        timestamp: 1,
        payload: { specName: "delivery-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_4",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Ship patch",
          description: "Land the runtime fix",
          dependencies: [],
        },
      },
      {
        kind: "task.added",
        eventId: "e3",
        teamRunId: "run_4",
        timestamp: 3,
        taskId: "task_a",
        payload: {
          subject: "Ship hotfix",
          description: "Land a different runtime fix",
          dependencies: ["task_b"],
        },
      },
    ]),
  ).toThrow(/conflicting duplicate task\.added/i);
});

test("rejects duplicate task.added replay when only targetAgentType differs", () => {
  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_4b",
        timestamp: 1,
        payload: { specName: "delivery-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_4b",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Ship patch",
          description: "Land the runtime fix",
          dependencies: [],
          targetAgentType: "implementer",
        },
      },
      {
        kind: "task.added",
        eventId: "e3",
        teamRunId: "run_4b",
        timestamp: 3,
        taskId: "task_a",
        payload: {
          subject: "Ship patch",
          description: "Land the runtime fix",
          dependencies: [],
          targetAgentType: "reviewer",
        },
      },
    ]),
  ).toThrow(/conflicting duplicate task\.added/i);
});

test("rejects task.assigned for an unknown taskId", () => {
  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_5",
        timestamp: 1,
        payload: { specName: "delivery-team" },
      },
      {
        kind: "task.assigned",
        eventId: "e2",
        teamRunId: "run_5",
        timestamp: 2,
        taskId: "missing_task",
        agentId: "coder-1",
        payload: {},
      },
    ]),
  ).toThrow(/cannot assign unknown task/i);
});

test("rejects task.completed for an unknown taskId", () => {
  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_6",
        timestamp: 1,
        payload: { specName: "delivery-team" },
      },
      {
        kind: "task.completed",
        eventId: "e2",
        teamRunId: "run_6",
        timestamp: 2,
        taskId: "missing_task",
        agentId: "coder-1",
        payload: { output: "done" },
      },
    ]),
  ).toThrow(/cannot complete unknown task/i);
});

test("rejects task.completed for a task that is still pending", () => {
  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_8",
        timestamp: 1,
        payload: { specName: "delivery-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_8",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Ship patch",
          description: "Land the runtime fix",
          dependencies: [],
        },
      },
      {
        kind: "task.completed",
        eventId: "e3",
        teamRunId: "run_8",
        timestamp: 3,
        taskId: "task_a",
        agentId: "coder-1",
        payload: { output: "done" },
      },
    ]),
  ).toThrow(/cannot complete pending task/i);
});

test("rejects task.assigned for a task that is already completed", () => {
  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_9",
        timestamp: 1,
        payload: { specName: "delivery-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_9",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Ship patch",
          description: "Land the runtime fix",
          dependencies: [],
        },
      },
      {
        kind: "task.assigned",
        eventId: "e3",
        teamRunId: "run_9",
        timestamp: 3,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
      {
        kind: "task.completed",
        eventId: "e4",
        teamRunId: "run_9",
        timestamp: 4,
        taskId: "task_a",
        agentId: "coder-1",
        payload: { output: "done" },
      },
      {
        kind: "task.assigned",
        eventId: "e5",
        teamRunId: "run_9",
        timestamp: 5,
        taskId: "task_a",
        agentId: "coder-2",
        payload: {},
      },
    ]),
  ).toThrow(/cannot assign completed task/i);
});

test("rejects task.completed by an agent other than the active assignee", () => {
  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_10",
        timestamp: 1,
        payload: { specName: "delivery-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_10",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Ship patch",
          description: "Land the runtime fix",
          dependencies: [],
        },
      },
      {
        kind: "task.assigned",
        eventId: "e3",
        teamRunId: "run_10",
        timestamp: 3,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
      {
        kind: "task.completed",
        eventId: "e4",
        teamRunId: "run_10",
        timestamp: 4,
        taskId: "task_a",
        agentId: "coder-2",
        payload: { output: "done" },
      },
    ]),
  ).toThrow(/cannot complete task assigned to another agent/i);
});

test("rejects malformed event kinds during replay", () => {
  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_7",
        timestamp: 1,
        payload: { specName: "delivery-team" },
      },
      {
        kind: "task.corrupted",
        eventId: "e2",
        teamRunId: "run_7",
        timestamp: 2,
        taskId: "task_a",
        payload: {},
      } as unknown as Parameters<typeof reduceTeamEvents>[0][number],
    ]),
  ).toThrow(/unhandled team event/i);
});

test("reports cyclic tasks as blocked instead of throwing during replay", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_cycle",
      timestamp: 1,
      payload: { specName: "cycle-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_cycle",
      timestamp: 2,
      taskId: "task_a",
      payload: { subject: "A", description: "A", dependencies: ["task_b"] },
    },
    {
      kind: "task.added",
      eventId: "e3",
      teamRunId: "run_cycle",
      timestamp: 3,
      taskId: "task_b",
      payload: { subject: "B", description: "B", dependencies: ["task_a"] },
    },
  ]);

  expect([...snapshot.blockedTaskIds].sort()).toEqual(["task_a", "task_b"]);
});

test("surfaces tasks with unknown dependencies as blocked", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_blocked",
      timestamp: 1,
      payload: { specName: "blocked-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_blocked",
      timestamp: 2,
      taskId: "task_a",
      payload: { subject: "A", description: "A", dependencies: ["task_missing"] },
    },
  ]);

  expect(snapshot.blockedTaskIds).toEqual(["task_a"]);
});

test("duplicate task.added replays cleanly even after later events backfill sharedResources", () => {
  const baseEvents = [
    {
      kind: "team.created" as const,
      eventId: "e1",
      teamRunId: "run_replay_safe",
      timestamp: 1,
      payload: { specName: "replay-safe-team" },
    },
    {
      kind: "task.added" as const,
      eventId: "e2",
      teamRunId: "run_replay_safe",
      timestamp: 2,
      taskId: "task_a",
      payload: { subject: "A", description: "A", dependencies: [] },
    },
    {
      kind: "task.assigned" as const,
      eventId: "e3",
      teamRunId: "run_replay_safe",
      timestamp: 3,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { sharedResources: ["pkg/foo.ts"] },
    },
  ];

  const snapshot = reduceTeamEvents([
    ...baseEvents,
    {
      kind: "task.added",
      eventId: "e2-replay",
      teamRunId: "run_replay_safe",
      timestamp: 4,
      taskId: "task_a",
      payload: { subject: "A", description: "A", dependencies: [] },
    },
  ]);

  expect(snapshot.board.get("task_a")?.sharedResources).toEqual(["pkg/foo.ts"]);
});

test("backfills sharedResources when a duplicate task.added carries them later", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_added_backfill",
      timestamp: 1,
      payload: { specName: "added-backfill-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_added_backfill",
      timestamp: 2,
      taskId: "task_a",
      payload: { subject: "A", description: "A", dependencies: [] },
    },
    {
      kind: "task.added",
      eventId: "e3",
      teamRunId: "run_added_backfill",
      timestamp: 3,
      taskId: "task_a",
      payload: {
        subject: "A",
        description: "A",
        dependencies: [],
        sharedResources: ["pkg/foo.ts"],
      },
    },
  ]);

  expect(snapshot.board.get("task_a")?.sharedResources).toEqual(["pkg/foo.ts"]);
});

test("rejects task.completed that backfills resources held by another active task", () => {
  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_complete_overlap",
        timestamp: 1,
        payload: { specName: "complete-overlap" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_complete_overlap",
        timestamp: 2,
        taskId: "task_a",
        payload: { subject: "A", description: "A", dependencies: [] },
      },
      {
        kind: "task.added",
        eventId: "e3",
        teamRunId: "run_complete_overlap",
        timestamp: 3,
        taskId: "task_b",
        payload: {
          subject: "B",
          description: "B",
          dependencies: [],
          sharedResources: ["pkg/foo.ts"],
        },
      },
      {
        kind: "task.assigned",
        eventId: "e4",
        teamRunId: "run_complete_overlap",
        timestamp: 4,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
      {
        kind: "task.assigned",
        eventId: "e5",
        teamRunId: "run_complete_overlap",
        timestamp: 5,
        taskId: "task_b",
        agentId: "coder-2",
        payload: {},
      },
      {
        kind: "task.completed",
        eventId: "e6",
        teamRunId: "run_complete_overlap",
        timestamp: 6,
        taskId: "task_a",
        agentId: "coder-1",
        payload: { output: "done", sharedResources: ["pkg/foo.ts"] },
      },
    ]),
  ).toThrow(/already held by/i);
});

test("flags hasUnknownActiveResources when an in-progress task has no declared resources", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_unknown",
      timestamp: 1,
      payload: { specName: "unknown-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_unknown",
      timestamp: 2,
      taskId: "task_a",
      payload: { subject: "A", description: "A", dependencies: [] },
    },
    {
      kind: "task.assigned",
      eventId: "e3",
      teamRunId: "run_unknown",
      timestamp: 3,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
  ]);

  expect(snapshot.hasUnknownActiveResources).toBe(true);
});

test("treats reordered sharedResources as equivalent during reconciliation", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_reorder",
      timestamp: 1,
      payload: { specName: "reorder-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_reorder",
      timestamp: 2,
      taskId: "task_a",
      payload: {
        subject: "A",
        description: "A",
        dependencies: [],
        sharedResources: ["a", "b"],
      },
    },
    {
      kind: "task.assigned",
      eventId: "e3",
      teamRunId: "run_reorder",
      timestamp: 3,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { sharedResources: ["b", "a"] },
    },
    {
      kind: "task.completed",
      eventId: "e4",
      teamRunId: "run_reorder",
      timestamp: 4,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { output: "done", sharedResources: ["b", "a"] },
    },
  ]);

  expect(snapshot.board.get("task_a")?.status).toBe("completed");
});

test("backfills sharedResources when a duplicate task.assigned carries them", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_dup_assign",
      timestamp: 1,
      payload: { specName: "dup-assign-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_dup_assign",
      timestamp: 2,
      taskId: "task_a",
      payload: { subject: "A", description: "A", dependencies: [] },
    },
    {
      kind: "task.assigned",
      eventId: "e3",
      teamRunId: "run_dup_assign",
      timestamp: 3,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
    {
      kind: "task.assigned",
      eventId: "e4",
      teamRunId: "run_dup_assign",
      timestamp: 4,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { sharedResources: ["pkg/foo.ts"] },
    },
  ]);

  expect(snapshot.board.get("task_a")?.sharedResources).toEqual(["pkg/foo.ts"]);
  expect([...snapshot.activeResources]).toEqual(["pkg/foo.ts"]);
});

test("rejects duplicate task.assigned with conflicting sharedResources", () => {
  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_assign_conflict",
        timestamp: 1,
        payload: { specName: "assign-conflict" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_assign_conflict",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "A",
          description: "A",
          dependencies: [],
          sharedResources: ["pkg/foo.ts"],
        },
      },
      {
        kind: "task.assigned",
        eventId: "e3",
        teamRunId: "run_assign_conflict",
        timestamp: 3,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
      {
        kind: "task.assigned",
        eventId: "e4",
        teamRunId: "run_assign_conflict",
        timestamp: 4,
        taskId: "task_a",
        agentId: "coder-1",
        payload: { sharedResources: ["pkg/bar.ts"] },
      },
    ]),
  ).toThrow(/conflicting sharedresources/i);
});

test("rejects duplicate task.completed with conflicting sharedResources", () => {
  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_complete_conflict",
        timestamp: 1,
        payload: { specName: "complete-conflict" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_complete_conflict",
        timestamp: 2,
        taskId: "task_a",
        payload: { subject: "A", description: "A", dependencies: [] },
      },
      {
        kind: "task.assigned",
        eventId: "e3",
        teamRunId: "run_complete_conflict",
        timestamp: 3,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
      {
        kind: "task.completed",
        eventId: "e4",
        teamRunId: "run_complete_conflict",
        timestamp: 4,
        taskId: "task_a",
        agentId: "coder-1",
        payload: { output: "done", sharedResources: ["pkg/foo.ts"] },
      },
      {
        kind: "task.completed",
        eventId: "e5",
        teamRunId: "run_complete_conflict",
        timestamp: 5,
        taskId: "task_a",
        agentId: "coder-1",
        payload: { output: "done", sharedResources: ["pkg/bar.ts"] },
      },
    ]),
  ).toThrow(/conflicting sharedresources/i);
});

test("rejects concurrent task.assigned events claiming the same resource", () => {
  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_excl",
        timestamp: 1,
        payload: { specName: "excl-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_excl",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "A",
          description: "A",
          dependencies: [],
          sharedResources: ["pkg/foo.ts"],
        },
      },
      {
        kind: "task.added",
        eventId: "e3",
        teamRunId: "run_excl",
        timestamp: 3,
        taskId: "task_b",
        payload: {
          subject: "B",
          description: "B",
          dependencies: [],
          sharedResources: ["pkg/foo.ts"],
        },
      },
      {
        kind: "task.assigned",
        eventId: "e4",
        teamRunId: "run_excl",
        timestamp: 4,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
      {
        kind: "task.assigned",
        eventId: "e5",
        teamRunId: "run_excl",
        timestamp: 5,
        taskId: "task_b",
        agentId: "coder-2",
        payload: {},
      },
    ]),
  ).toThrow(/shared resource pkg\/foo\.ts already held/i);
});

test("hydrates sharedResources from task.completed payload for legacy streams", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_legacy_complete",
      timestamp: 1,
      payload: { specName: "legacy-complete-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_legacy_complete",
      timestamp: 2,
      taskId: "task_a",
      payload: { subject: "A", description: "A", dependencies: [] },
    },
    {
      kind: "task.assigned",
      eventId: "e3",
      teamRunId: "run_legacy_complete",
      timestamp: 3,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
    {
      kind: "task.completed",
      eventId: "e4",
      teamRunId: "run_legacy_complete",
      timestamp: 4,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { output: "done", sharedResources: ["pkg/foo.ts"] },
    },
  ]);

  expect(snapshot.board.get("task_a")?.sharedResources).toEqual(["pkg/foo.ts"]);
});

test("hydrates sharedResources from task.assigned for in-progress legacy streams", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_legacy_assign",
      timestamp: 1,
      payload: { specName: "legacy-assign-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_legacy_assign",
      timestamp: 2,
      taskId: "task_a",
      payload: { subject: "A", description: "A", dependencies: [] },
    },
    {
      kind: "task.assigned",
      eventId: "e3",
      teamRunId: "run_legacy_assign",
      timestamp: 3,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { sharedResources: ["pkg/bar.ts"] },
    },
  ]);

  expect([...snapshot.activeResources]).toEqual(["pkg/bar.ts"]);
});

test("tracks active resources from in-progress assignments", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_res",
      timestamp: 1,
      payload: { specName: "res-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_res",
      timestamp: 2,
      taskId: "task_a",
      payload: {
        subject: "A",
        description: "A",
        dependencies: [],
        sharedResources: ["lockfile.json"],
      },
    },
    {
      kind: "task.assigned",
      eventId: "e3",
      teamRunId: "run_res",
      timestamp: 3,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
  ]);

  expect([...snapshot.activeResources]).toEqual(["lockfile.json"]);
});
