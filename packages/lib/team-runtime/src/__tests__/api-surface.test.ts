import { expect, test } from "bun:test";
import * as api from "../index.js";

test("exports the team runtime public surface", () => {
  expect(api.createTeamRuntime).toBeFunction();
  expect(api.validateTeamSpec).toBeFunction();
  expect(api.planRunnableTasks).toBeFunction();
  expect(api.reduceTeamEvents).toBeFunction();
  expect(api.createTeamScheduler).toBeFunction();
  expect(api.createFileTeamMailbox).toBeFunction();
  expect(api.createTeamManager).toBeFunction();
  expect(api.createTeamCreateTool).toBeFunction();
  expect(api.createTeamDeleteTool).toBeFunction();
  expect(api.createTeamAssignTaskTool).toBeFunction();
  expect(api.createTeamReportTaskTool).toBeFunction();
  expect(api.findInProcessTeammateTaskId).toBeFunction();
  expect(api.setAwaitingPlanApproval).toBeFunction();
  expect(api.handlePlanApprovalResponse).toBeFunction();
  expect(api.isPlanModeRequired).toBeFunction();
  expect(api.createTaskAssignmentMessage).toBeFunction();
  expect(api.createTaskReportMessage).toBeFunction();
  expect(api.parseTeamProtocolMessage).toBeFunction();
});

test("public surface exposes future-stable contracts", async () => {
  const assigned: Array<{ taskId: string; agentId: string }> = [];
  const spec = api.validateTeamSpec({
    name: "delivery-team",
    agents: [{ agentType: "implementer", planModeRequired: true }],
    budget: { total: 10, reserve: 1, defaultSlice: 2 },
    workspacePolicy: { mode: "isolated", sharedResources: ["README.md"] },
  });
  const snapshot = api.reduceTeamEvents([
    {
      kind: "team.created",
      eventId: "e1",
      teamRunId: "run_1",
      timestamp: 1,
      payload: { specName: spec.name },
    },
    {
      kind: "task.added",
      eventId: "e2",
      teamRunId: "run_1",
      timestamp: 2,
      taskId: "task_a",
      payload: {
        subject: "Implement scheduler contract",
        description: "Create the dispatch surface",
        dependencies: [],
      },
    },
  ]);
  const scheduler = api.createTeamScheduler({
    assign: async (task, agentId) => {
      assigned.push({ taskId: task.taskId, agentId });
    },
  });
  const runtime = api.createTeamRuntime(spec);
  const startHandle = await runtime.start({ goal: "Ship the patch" });
  const resumeHandle = await runtime.resume({ events: [] });

  expect(spec).toEqual({
    ...spec,
    agents: [{ agentType: "implementer", planModeRequired: true }],
    budget: { total: 10, reserve: 1, defaultSlice: 2 },
    workspacePolicy: { mode: "isolated", sharedResources: ["README.md"] },
  });
  expect(snapshot).toHaveProperty("teamRunId");
  expect(snapshot).toHaveProperty("board");
  expect(snapshot.outputs).toBeInstanceOf(Map);
  expect(snapshot.activeAssignments).toBeInstanceOf(Map);
  expect(Array.isArray(snapshot.events)).toBe(true);
  expect(Array.isArray(api.planRunnableTasks(snapshot))).toBe(true);
  await expect(scheduler.dispatch(snapshot, ["agent-1"])).resolves.toBeUndefined();
  expect(assigned).toEqual([{ taskId: "task_a", agentId: "agent-1" }]);
  expect(runtime.getSnapshot()).toHaveProperty("board");
  expect(runtime.replay([])).toHaveProperty("outputs");
  expect(startHandle.teamRunId).toBeString();
  expect(startHandle.getStatus).toBeFunction();
  expect(startHandle.getSnapshot()).toHaveProperty("board");
  await expect(startHandle.getResult()).resolves.toHaveProperty("outputs");
  expect(resumeHandle.getStatus()).toBeString();
  expect(resumeHandle.getSnapshot()).toHaveProperty("teamRunId");
  await expect(resumeHandle.getResult()).resolves.toHaveProperty("events");
});
