import { expect, test } from "bun:test";
import { replayTeamRun } from "./replay.js";
import { createTeamRuntime } from "./runtime.js";
import { createTeamScheduler } from "./scheduler.js";
import { reduceTeamEvents } from "./state.js";

test("dispatches available agents across the current runnable wave in dependency order", async () => {
  const assigned: Array<{ taskId: string; agentId: string }> = [];
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_dispatch",
      timestamp: 1,
      payload: { specName: "dispatch-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_dispatch",
      timestamp: 2,
      taskId: "task_merge",
      payload: {
        subject: "Merge results",
        description: "Wait for task_a",
        dependencies: ["task_a"],
      },
    },
    {
      kind: "task.added",
      eventId: "e3",
      teamRunId: "run_dispatch",
      timestamp: 3,
      taskId: "task_c",
      payload: {
        subject: "Another independent root",
        description: "Also runnable immediately",
        dependencies: [],
      },
    },
    {
      kind: "task.added",
      eventId: "e4",
      teamRunId: "run_dispatch",
      timestamp: 4,
      taskId: "task_b",
      payload: {
        subject: "Independent root",
        description: "Can run immediately",
        dependencies: [],
      },
    },
    {
      kind: "task.added",
      eventId: "e5",
      teamRunId: "run_dispatch",
      timestamp: 5,
      taskId: "task_a",
      payload: {
        subject: "Upstream dependency",
        description: "Completes before merge",
        dependencies: [],
      },
    },
    {
      kind: "task.assigned",
      eventId: "e6",
      teamRunId: "run_dispatch",
      timestamp: 6,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
    {
      kind: "task.completed",
      eventId: "e7",
      teamRunId: "run_dispatch",
      timestamp: 7,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { output: "done" },
    },
  ]);

  const scheduler = createTeamScheduler({
    assign: async (task, agentId) => {
      assigned.push({ taskId: task.taskId, agentId });
    },
  });

  await scheduler.dispatch(snapshot, ["coder-2", "coder-3"]);

  expect(assigned).toEqual([
    { taskId: "task_c", agentId: "coder-2" },
    { taskId: "task_b", agentId: "coder-3" },
  ]);
});

test("preserves planner order even when assign resolves asynchronously", async () => {
  const started: string[] = [];
  let releaseFirstAssignment: (() => void) | undefined;
  const firstAssignmentReleased = new Promise<void>((resolve) => {
    releaseFirstAssignment = resolve;
  });
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_async_dispatch",
      timestamp: 1,
      payload: { specName: "async-dispatch-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_async_dispatch",
      timestamp: 2,
      taskId: "task_merge",
      payload: {
        subject: "Merge results",
        description: "Wait for task_a",
        dependencies: ["task_a"],
      },
    },
    {
      kind: "task.added",
      eventId: "e3",
      teamRunId: "run_async_dispatch",
      timestamp: 3,
      taskId: "task_c",
      payload: {
        subject: "Another independent root",
        description: "Also runnable immediately",
        dependencies: [],
      },
    },
    {
      kind: "task.added",
      eventId: "e4",
      teamRunId: "run_async_dispatch",
      timestamp: 4,
      taskId: "task_b",
      payload: {
        subject: "Independent root",
        description: "Can run immediately",
        dependencies: [],
      },
    },
    {
      kind: "task.added",
      eventId: "e5",
      teamRunId: "run_async_dispatch",
      timestamp: 5,
      taskId: "task_a",
      payload: {
        subject: "Upstream dependency",
        description: "Completes before merge",
        dependencies: [],
      },
    },
    {
      kind: "task.assigned",
      eventId: "e6",
      teamRunId: "run_async_dispatch",
      timestamp: 6,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
    {
      kind: "task.completed",
      eventId: "e7",
      teamRunId: "run_async_dispatch",
      timestamp: 7,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { output: "done" },
    },
  ]);

  const scheduler = createTeamScheduler({
    assign: async (task, agentId) => {
      started.push(`${task.taskId}:${agentId}`);
      if (task.taskId === "task_c") {
        await firstAssignmentReleased;
      }
    },
  });

  const dispatchPromise = scheduler.dispatch(snapshot, ["coder-2", "coder-3"]);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toEqual(["task_c:coder-2", "task_b:coder-3"]);

  releaseFirstAssignment?.();
  await dispatchPromise;
});

test("runtime replay delegates to the shared replay reducer for resumable snapshots", () => {
  const events = [
    {
      kind: "team.created" as const,
      eventId: "e1",
      teamRunId: "run_resume",
      timestamp: 1,
      payload: { specName: "resume-team" },
    },
    {
      kind: "task.added" as const,
      eventId: "e2",
      teamRunId: "run_resume",
      timestamp: 2,
      taskId: "task_a",
      payload: {
        subject: "Resume task",
        description: "Recover prior state",
        dependencies: [],
      },
    },
  ];
  const runtime = createTeamRuntime({
    name: "resume-team",
    agents: [{ agentType: "coder" }],
    budget: { total: 100, defaultSlice: 25 },
    workspacePolicy: { mode: "hybrid" },
  });

  const replayed = replayTeamRun(events);
  const snapshot = runtime.replay(events);

  expect(snapshot.teamRunId).toBe(replayed.teamRunId);
  expect(snapshot.events).toEqual(replayed.events);
  expect(snapshot.board.all()).toEqual(replayed.board.all());
  expect([...snapshot.outputs]).toEqual([...replayed.outputs]);
  expect([...snapshot.activeAssignments]).toEqual([...replayed.activeAssignments]);
  expect(runtime.getSnapshot().board.all()).toEqual(replayed.board.all());
  expect(snapshot.teamRunId).toBe("run_resume");
  expect(snapshot.board.ready().map((task) => task.taskId)).toEqual(["task_a"]);
});

test("runtime handles expose snapshot-only semantics for start and resume", async () => {
  const runtime = createTeamRuntime({
    name: "surface-team",
    agents: [{ agentType: "coder" }],
    budget: { total: 100, defaultSlice: 25 },
    workspacePolicy: { mode: "hybrid" },
  });
  const resumedEvents = [
    {
      kind: "team.created" as const,
      eventId: "e1",
      teamRunId: "run_existing",
      timestamp: 1,
      payload: { specName: "surface-team" },
    },
  ];

  const started = await runtime.start({
    goal: "This goal is accepted for future orchestration but ignored in Task 5",
    tasks: [
      {
        taskId: "task_future",
        subject: "Future task",
        description: "Not materialized by Task 5 runtime.start()",
        dependencies: [],
      },
    ],
  });
  const startedAgain = await runtime.start({
    goal: "Repeated starts should create distinct snapshot-only runs",
  });

  expect(started.teamRunId).toBe("surface-team:run:1");
  expect(started.getStatus()).toBe("snapshot_ready");
  expect(started.getSnapshot().events).toEqual([
    {
      kind: "team.created",
      eventId: "team.created:surface-team:run:1",
      teamRunId: "surface-team:run:1",
      timestamp: 0,
      payload: { specName: "surface-team" },
    },
  ]);
  const startedResult = await started.getResult();
  expect(startedResult.teamRunId).toBe(started.getSnapshot().teamRunId);
  expect(startedResult.events).toEqual(started.getSnapshot().events);
  expect(startedResult.board.all()).toEqual(started.getSnapshot().board.all());
  expect(started.getSnapshot().board.all()).toEqual([]);
  expect(startedAgain.teamRunId).toBe("surface-team:run:2");
  expect(startedAgain.teamRunId).not.toBe(started.teamRunId);
  expect(startedAgain.getSnapshot().events).toEqual([
    {
      kind: "team.created",
      eventId: "team.created:surface-team:run:2",
      teamRunId: "surface-team:run:2",
      timestamp: 0,
      payload: { specName: "surface-team" },
    },
  ]);
  const startedAgainResult = await startedAgain.getResult();
  expect(startedAgainResult.teamRunId).toBe(startedAgain.getSnapshot().teamRunId);
  expect(startedAgainResult.events).toEqual(startedAgain.getSnapshot().events);
  expect(startedAgainResult.board.all()).toEqual(startedAgain.getSnapshot().board.all());

  const resumed = await runtime.resume({ events: resumedEvents });

  expect(resumed.teamRunId).toBe("run_existing");
  expect(resumed.getStatus()).toBe("snapshot_ready");
  expect(resumed.getSnapshot().events).toEqual(resumedEvents);
  const resumedResult = await resumed.getResult();
  expect(resumedResult.teamRunId).toBe(resumed.getSnapshot().teamRunId);
  expect(resumedResult.events).toEqual(resumed.getSnapshot().events);
  expect(resumedResult.board.all()).toEqual(resumed.getSnapshot().board.all());
});

test("runtime returns detached snapshots so caller mutation does not leak back in", async () => {
  const runtime = createTeamRuntime({
    name: "detached-team",
    agents: [{ agentType: "coder" }],
    budget: { total: 100, defaultSlice: 25 },
    workspacePolicy: { mode: "hybrid" },
  });
  const replayed = runtime.replay([
    {
      kind: "team.created" as const,
      eventId: "e1",
      teamRunId: "run_detached",
      timestamp: 1,
      payload: { specName: "detached-team" },
    },
  ]);

  (replayed as { teamRunId: string }).teamRunId = "mutated-run";
  (replayed.events as unknown as Array<{ eventId: string }>).push({
    eventId: "mutated-event",
  });

  const currentSnapshot = runtime.getSnapshot();

  expect(currentSnapshot.teamRunId).toBe("run_detached");
  expect(currentSnapshot.events).toHaveLength(1);
  expect(currentSnapshot.events[0]?.eventId).toBe("e1");
  expect(currentSnapshot.outputs).not.toBe(replayed.outputs);
  expect(currentSnapshot.activeAssignments).not.toBe(replayed.activeAssignments);

  const started = await runtime.start({ goal: "Create detached snapshot handle" });
  const handleSnapshot = started.getSnapshot();
  (handleSnapshot as { teamRunId: string }).teamRunId = "mutated-handle-run";
  (handleSnapshot.events as unknown as Array<{ eventId: string }>).push({
    eventId: "mutated-handle-event",
  });

  const handleResult = await started.getResult();

  expect(handleResult.teamRunId).toBe(started.teamRunId);
  expect(handleResult.events).toHaveLength(1);
  expect(handleResult.events[0]?.eventId).toBe(`team.created:${started.teamRunId}`);
  expect(handleResult.outputs).not.toBe(handleSnapshot.outputs);
  expect(handleResult.activeAssignments).not.toBe(handleSnapshot.activeAssignments);
});
