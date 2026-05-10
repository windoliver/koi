import { expect, test } from "bun:test";
import { planRunnableTasks } from "./planner.js";
import { reduceTeamEvents } from "./state.js";

test("returns the current runnable wave in dependency order", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_wave",
      timestamp: 1,
      payload: { specName: "wave-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_wave",
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
      teamRunId: "run_wave",
      timestamp: 3,
      taskId: "task_b",
      payload: {
        subject: "Independent root",
        description: "Can run immediately",
        dependencies: [],
      },
    },
    {
      kind: "task.added",
      eventId: "e4",
      teamRunId: "run_wave",
      timestamp: 4,
      taskId: "task_a",
      payload: {
        subject: "Upstream dependency",
        description: "Completes before merge",
        dependencies: [],
      },
    },
    {
      kind: "task.assigned",
      eventId: "e5",
      teamRunId: "run_wave",
      timestamp: 5,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
    {
      kind: "task.completed",
      eventId: "e6",
      teamRunId: "run_wave",
      timestamp: 6,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { output: "done" },
    },
  ]);

  expect(planRunnableTasks(snapshot).map((task) => task.taskId)).toEqual(["task_b", "task_merge"]);
});

test("unblocks the next wave only after all upstream tasks complete", () => {
  const beforeCompletion = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_wave_gate",
      timestamp: 1,
      payload: { specName: "wave-gate-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_wave_gate",
      timestamp: 2,
      taskId: "task_a",
      payload: {
        subject: "A",
        description: "A",
        dependencies: [],
      },
    },
    {
      kind: "task.added",
      eventId: "e3",
      teamRunId: "run_wave_gate",
      timestamp: 3,
      taskId: "task_b",
      payload: {
        subject: "B",
        description: "B",
        dependencies: [],
      },
    },
    {
      kind: "task.added",
      eventId: "e4",
      teamRunId: "run_wave_gate",
      timestamp: 4,
      taskId: "task_merge",
      payload: {
        subject: "Merge",
        description: "Merge",
        dependencies: ["task_a", "task_b"],
      },
    },
    {
      kind: "task.assigned",
      eventId: "e5",
      teamRunId: "run_wave_gate",
      timestamp: 5,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
    {
      kind: "task.completed",
      eventId: "e6",
      teamRunId: "run_wave_gate",
      timestamp: 6,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { output: "done-a" },
    },
  ]);

  expect(planRunnableTasks(beforeCompletion).map((task) => task.taskId)).toEqual(["task_b"]);

  const afterCompletion = reduceTeamEvents([
    ...beforeCompletion.events,
    {
      kind: "task.assigned",
      eventId: "e7",
      teamRunId: "run_wave_gate",
      timestamp: 7,
      taskId: "task_b",
      agentId: "coder-2",
      payload: {},
    },
    {
      kind: "task.completed",
      eventId: "e8",
      teamRunId: "run_wave_gate",
      timestamp: 8,
      taskId: "task_b",
      agentId: "coder-2",
      payload: { output: "done-b" },
    },
  ]);

  expect(planRunnableTasks(afterCompletion).map((task) => task.taskId)).toEqual(["task_merge"]);
});

test("snapshot maps stay Map-backed while blocking mutators", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_maps",
      timestamp: 1,
      payload: { specName: "maps-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_maps",
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
      kind: "task.assigned",
      eventId: "e3",
      teamRunId: "run_maps",
      timestamp: 3,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
    {
      kind: "task.completed",
      eventId: "e4",
      teamRunId: "run_maps",
      timestamp: 4,
      taskId: "task_a",
      agentId: "coder-1",
      payload: { output: "done" },
    },
  ]);

  const outputs = snapshot.outputs as unknown as Record<string, unknown>;
  const activeAssignments = snapshot.activeAssignments as unknown as Record<string, unknown>;
  const listed = snapshot.board.all();
  const first = listed[0];

  expect(snapshot.outputs).toBeInstanceOf(Map);
  expect(snapshot.activeAssignments).toBeInstanceOf(Map);
  expect(snapshot.outputs.get("task_a")).toBe("done");
  expect(snapshot.activeAssignments.has("task_a")).toBe(false);
  expect(snapshot.board.get("missing_task")).toBeUndefined();
  expect(first?.targetAgentType).toBe("implementer");
  expect(first?.status).toBe("completed");
  if (first !== undefined) {
    (first.dependencies as unknown as string[]).push("mutated");
  }
  expect(snapshot.board.get("task_a")?.dependencies).toEqual([]);
  expect(outputs.set).toBeUndefined();
  expect(outputs.delete).toBeUndefined();
  expect(outputs.clear).toBeUndefined();
  expect(activeAssignments.set).toBeUndefined();
  expect(activeAssignments.delete).toBeUndefined();
  expect(activeAssignments.clear).toBeUndefined();
});

test("reducer rejects mixed runs, conflicting replays, and invalid event transitions", () => {
  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_created_replay",
        timestamp: 1,
        payload: { specName: "original-team" },
      },
      {
        kind: "team.created",
        eventId: "e2",
        teamRunId: "run_created_replay",
        timestamp: 2,
        payload: { specName: "different-team" },
      },
    ]),
  ).toThrow(/Conflicting duplicate team\.created event/i);

  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_1",
        timestamp: 1,
        payload: { specName: "mixed-team" },
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

  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_replay",
        timestamp: 1,
        payload: { specName: "replay-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_replay",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Task A",
          description: "First copy",
          dependencies: [],
        },
      },
      {
        kind: "task.added",
        eventId: "e3",
        teamRunId: "run_replay",
        timestamp: 3,
        taskId: "task_a",
        payload: {
          subject: "Task A",
          description: "Changed copy",
          dependencies: [],
        },
      },
    ]),
  ).toThrow(/Conflicting duplicate task\.added event/i);

  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_exact_replay",
        timestamp: 1,
        payload: { specName: "exact-replay-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_exact_replay",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Task A",
          description: "Original copy",
          dependencies: [],
          targetAgentType: "implementer",
        },
      },
      {
        kind: "task.added",
        eventId: "e3",
        teamRunId: "run_exact_replay",
        timestamp: 3,
        taskId: "task_a",
        payload: {
          subject: "Task A",
          description: "Original copy",
          dependencies: [],
          targetAgentType: "implementer",
        },
      },
      {
        kind: "task.assigned",
        eventId: "e4",
        teamRunId: "run_exact_replay",
        timestamp: 4,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
      {
        kind: "task.completed",
        eventId: "e5",
        teamRunId: "run_exact_replay",
        timestamp: 5,
        taskId: "task_a",
        agentId: "coder-1",
        payload: { output: "done" },
      },
      {
        kind: "task.added",
        eventId: "e6",
        teamRunId: "run_exact_replay",
        timestamp: 6,
        taskId: "task_a",
        payload: {
          subject: "Task A",
          description: "Original copy",
          dependencies: [],
          targetAgentType: "implementer",
        },
      },
    ]),
  ).not.toThrow();

  expect(() => {
    const snapshot = reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_assignment_replay",
        timestamp: 1,
        payload: { specName: "assignment-replay-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_assignment_replay",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Task A",
          description: "Original copy",
          dependencies: [],
        },
      },
      {
        kind: "task.assigned",
        eventId: "e3",
        teamRunId: "run_assignment_replay",
        timestamp: 3,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
      {
        kind: "task.assigned",
        eventId: "e4",
        teamRunId: "run_assignment_replay",
        timestamp: 4,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
    ]);

    expect(snapshot.board.get("task_a")?.status).toBe("in_progress");
    expect(snapshot.board.get("task_a")?.assignedAgentId).toBe("coder-1");
    expect(snapshot.activeAssignments.get("task_a")).toBe("coder-1");
  }).not.toThrow();

  expect(() => {
    const snapshot = reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_completion_replay",
        timestamp: 1,
        payload: { specName: "completion-replay-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_completion_replay",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Task A",
          description: "Original copy",
          dependencies: [],
        },
      },
      {
        kind: "task.assigned",
        eventId: "e3",
        teamRunId: "run_completion_replay",
        timestamp: 3,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
      {
        kind: "task.completed",
        eventId: "e4",
        teamRunId: "run_completion_replay",
        timestamp: 4,
        taskId: "task_a",
        agentId: "coder-1",
        payload: { output: "done" },
      },
      {
        kind: "task.completed",
        eventId: "e5",
        teamRunId: "run_completion_replay",
        timestamp: 5,
        taskId: "task_a",
        agentId: "coder-1",
        payload: { output: "done" },
      },
    ]);

    expect(snapshot.board.get("task_a")?.status).toBe("completed");
    expect(snapshot.outputs.get("task_a")).toBe("done");
    expect(snapshot.activeAssignments.has("task_a")).toBe(false);
  }).not.toThrow();

  expect(() => {
    const snapshot = reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_post_completion_assignment_replay",
        timestamp: 1,
        payload: { specName: "post-completion-assignment-replay-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_post_completion_assignment_replay",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Task A",
          description: "Original copy",
          dependencies: [],
        },
      },
      {
        kind: "task.assigned",
        eventId: "e3",
        teamRunId: "run_post_completion_assignment_replay",
        timestamp: 3,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
      {
        kind: "task.completed",
        eventId: "e4",
        teamRunId: "run_post_completion_assignment_replay",
        timestamp: 4,
        taskId: "task_a",
        agentId: "coder-1",
        payload: { output: "done" },
      },
      {
        kind: "task.assigned",
        eventId: "e5",
        teamRunId: "run_post_completion_assignment_replay",
        timestamp: 5,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
    ]);

    expect(snapshot.board.get("task_a")?.status).toBe("completed");
    expect(snapshot.board.get("task_a")?.assignedAgentId).toBe("coder-1");
    expect(snapshot.outputs.get("task_a")).toBe("done");
    expect(snapshot.activeAssignments.has("task_a")).toBe(false);
  }).not.toThrow();

  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_reassign_conflict",
        timestamp: 1,
        payload: { specName: "reassign-conflict-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_reassign_conflict",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Task A",
          description: "Original copy",
          dependencies: [],
        },
      },
      {
        kind: "task.assigned",
        eventId: "e3",
        teamRunId: "run_reassign_conflict",
        timestamp: 3,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
      {
        kind: "task.assigned",
        eventId: "e4",
        teamRunId: "run_reassign_conflict",
        timestamp: 4,
        taskId: "task_a",
        agentId: "coder-2",
        payload: {},
      },
    ]),
  ).toThrow(/already assigned|another agent|different agent/i);

  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_completion_conflict",
        timestamp: 1,
        payload: { specName: "completion-conflict-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_completion_conflict",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Task A",
          description: "Original copy",
          dependencies: [],
        },
      },
      {
        kind: "task.assigned",
        eventId: "e3",
        teamRunId: "run_completion_conflict",
        timestamp: 3,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
      {
        kind: "task.completed",
        eventId: "e4",
        teamRunId: "run_completion_conflict",
        timestamp: 4,
        taskId: "task_a",
        agentId: "coder-1",
        payload: { output: "done" },
      },
      {
        kind: "task.completed",
        eventId: "e5",
        teamRunId: "run_completion_conflict",
        timestamp: 5,
        taskId: "task_a",
        agentId: "coder-1",
        payload: { output: "different" },
      },
    ]),
  ).toThrow(/already completed|conflicting duplicate task\.completed|different output/i);

  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_assign_unknown",
        timestamp: 1,
        payload: { specName: "assign-unknown-team" },
      },
      {
        kind: "task.assigned",
        eventId: "e2",
        teamRunId: "run_assign_unknown",
        timestamp: 2,
        taskId: "task_missing",
        agentId: "coder-1",
        payload: {},
      },
    ]),
  ).toThrow(/Cannot assign unknown task/i);

  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_assign_completed",
        timestamp: 1,
        payload: { specName: "assign-completed-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_assign_completed",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Task A",
          description: "Completed work",
          dependencies: [],
        },
      },
      {
        kind: "task.assigned",
        eventId: "e3",
        teamRunId: "run_assign_completed",
        timestamp: 3,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
      {
        kind: "task.completed",
        eventId: "e4",
        teamRunId: "run_assign_completed",
        timestamp: 4,
        taskId: "task_a",
        agentId: "coder-1",
        payload: { output: "done" },
      },
      {
        kind: "task.assigned",
        eventId: "e5",
        teamRunId: "run_assign_completed",
        timestamp: 5,
        taskId: "task_a",
        agentId: "coder-2",
        payload: {},
      },
    ]),
  ).toThrow(/Cannot assign completed task/i);

  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_complete_unknown",
        timestamp: 1,
        payload: { specName: "complete-unknown-team" },
      },
      {
        kind: "task.completed",
        eventId: "e2",
        teamRunId: "run_complete_unknown",
        timestamp: 2,
        taskId: "task_missing",
        agentId: "coder-1",
        payload: { output: "done" },
      },
    ]),
  ).toThrow(/Cannot complete unknown task/i);

  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_complete_pending",
        timestamp: 1,
        payload: { specName: "complete-pending-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_complete_pending",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Task A",
          description: "Pending work",
          dependencies: [],
        },
      },
      {
        kind: "task.completed",
        eventId: "e3",
        teamRunId: "run_complete_pending",
        timestamp: 3,
        taskId: "task_a",
        agentId: "coder-1",
        payload: { output: "done" },
      },
    ]),
  ).toThrow(/Cannot complete pending task/i);

  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_wrong_agent",
        timestamp: 1,
        payload: { specName: "wrong-agent-team" },
      },
      {
        kind: "task.added",
        eventId: "e2",
        teamRunId: "run_wrong_agent",
        timestamp: 2,
        taskId: "task_a",
        payload: {
          subject: "Task A",
          description: "Assigned elsewhere",
          dependencies: [],
        },
      },
      {
        kind: "task.assigned",
        eventId: "e3",
        teamRunId: "run_wrong_agent",
        timestamp: 3,
        taskId: "task_a",
        agentId: "coder-1",
        payload: {},
      },
      {
        kind: "task.completed",
        eventId: "e4",
        teamRunId: "run_wrong_agent",
        timestamp: 4,
        taskId: "task_a",
        agentId: "coder-2",
        payload: { output: "done" },
      },
    ]),
  ).toThrow(/another agent/i);

  expect(() =>
    reduceTeamEvents([
      {
        kind: "team.created",
        eventId: "e1",
        teamRunId: "run_invalid_kind",
        timestamp: 1,
        payload: { specName: "invalid-kind-team" },
      },
      {
        kind: "task.unknown",
        eventId: "e2",
        teamRunId: "run_invalid_kind",
        timestamp: 2,
        taskId: "task_a",
        payload: {},
      } as never,
    ]),
  ).toThrow(/Unhandled team event/i);
});

test("planner skips tasks whose shared resources are already in use", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_res_plan",
      timestamp: 1,
      payload: { specName: "res-plan-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_res_plan",
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
      teamRunId: "run_res_plan",
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
      teamRunId: "run_res_plan",
      timestamp: 4,
      taskId: "task_a",
      agentId: "coder-1",
      payload: {},
    },
  ]);

  expect(planRunnableTasks(snapshot).map((task) => task.taskId)).toEqual([]);
});

test("planner serializes runnable tasks contending for the same resource", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_res_serial",
      timestamp: 1,
      payload: { specName: "res-serial-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_res_serial",
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
      teamRunId: "run_res_serial",
      timestamp: 3,
      taskId: "task_b",
      payload: {
        subject: "B",
        description: "B",
        dependencies: [],
        sharedResources: ["pkg/foo.ts"],
      },
    },
  ]);

  expect(planRunnableTasks(snapshot).map((task) => task.taskId)).toEqual(["task_a"]);
});

test("planner halts all dispatch while unknown-resource assignments are active", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_unknown_plan",
      timestamp: 1,
      payload: { specName: "unknown-plan-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_unknown_plan",
      timestamp: 2,
      taskId: "task_legacy",
      payload: { subject: "Legacy", description: "Legacy", dependencies: [] },
    },
    {
      kind: "task.added",
      eventId: "e3",
      teamRunId: "run_unknown_plan",
      timestamp: 3,
      taskId: "task_resource",
      payload: {
        subject: "Resource",
        description: "Resource",
        dependencies: [],
        sharedResources: ["pkg/foo.ts"],
      },
    },
    {
      kind: "task.added",
      eventId: "e4",
      teamRunId: "run_unknown_plan",
      timestamp: 4,
      taskId: "task_free",
      payload: { subject: "Free", description: "Free", dependencies: [] },
    },
    {
      kind: "task.assigned",
      eventId: "e5",
      teamRunId: "run_unknown_plan",
      timestamp: 5,
      taskId: "task_legacy",
      agentId: "coder-1",
      payload: {},
    },
  ]);

  expect(planRunnableTasks(snapshot)).toEqual([]);
});

test("planner excludes blocked tasks even if they appear runnable by status", () => {
  const snapshot = reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_block",
      timestamp: 1,
      payload: { specName: "block-team" },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_block",
      timestamp: 2,
      taskId: "task_a",
      payload: { subject: "A", description: "A", dependencies: ["task_missing"] },
    },
  ]);

  expect(planRunnableTasks(snapshot)).toEqual([]);
});
