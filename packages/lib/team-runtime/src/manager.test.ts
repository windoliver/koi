import { expect, test } from "bun:test";
import {
  createTeamAssignTaskTool,
  createTeamCreateTool,
  createTeamDeleteTool,
  createTeamManager,
  createTeamReportTaskTool,
} from "./manager.js";

test("team manager creates teams, rejects duplicate names, and deletes cleanly", async () => {
  const manager = createTeamManager();

  const created = await manager.createTeam({
    name: "alpha",
    lead: { agentId: "lead-1", agentName: "team-lead", role: "lead" },
    teammates: [
      {
        agentId: "worker-1",
        agentName: "researcher",
        role: "teammate",
        planModeRequired: true,
      },
    ],
  });

  expect(created.ok).toBe(true);
  expect(manager.getTeam("alpha")?.members.map((member) => member.agentName)).toEqual([
    "team-lead",
    "researcher",
  ]);
  expect(manager.getTeam("alpha")?.members[1]?.planModeRequired).toBe(true);

  const duplicate = await manager.createTeam({
    name: "alpha",
    lead: { agentId: "lead-2", agentName: "other-lead", role: "lead" },
    teammates: [],
  });
  expect(duplicate).toEqual({ ok: false, error: 'Team "alpha" already exists' });

  expect(await manager.deleteTeam("alpha")).toEqual({ ok: true });
  expect(manager.getTeam("alpha")).toBeUndefined();
});

test("team manager supports membership changes and task reporting", async () => {
  const manager = createTeamManager();
  await manager.createTeam({
    name: "alpha",
    lead: { agentId: "lead-1", agentName: "team-lead", role: "lead" },
    teammates: [],
  });

  expect(
    await manager.addMember("alpha", {
      agentId: "worker-1",
      agentName: "coder",
      role: "teammate",
    }),
  ).toEqual({ ok: true });

  expect(
    await manager.assignTask("alpha", {
      taskId: "task-1",
      assignedBy: "lead-1",
      assignedTo: "worker-1",
      description: "Implement mailbox",
    }),
  ).toEqual({ ok: true });

  expect(
    await manager.reportTask("alpha", {
      taskId: "task-1",
      agentId: "worker-1",
      output: "done",
    }),
  ).toEqual({ ok: true });

  expect(manager.getTeam("alpha")?.tasks.get("task-1")).toEqual({
    taskId: "task-1",
    assignedBy: "lead-1",
    assignedTo: "worker-1",
    description: "Implement mailbox",
    status: "completed",
    output: "done",
  });

  expect(await manager.removeMember("alpha", "worker-1")).toEqual({ ok: true });
  expect(manager.getTeam("alpha")?.members.map((member) => member.agentId)).toEqual(["lead-1"]);
});

test("team manager only allows the lead to assign teammate tasks", async () => {
  const manager = createTeamManager();
  await manager.createTeam({
    name: "alpha",
    lead: { agentId: "lead-1", agentName: "team-lead", role: "lead" },
    teammates: [
      { agentId: "worker-1", agentName: "coder", role: "teammate" },
      { agentId: "worker-2", agentName: "reviewer", role: "teammate" },
    ],
  });

  expect(
    await manager.assignTask("alpha", {
      taskId: "task-1",
      assignedBy: "worker-1",
      assignedTo: "worker-2",
      description: "Review patch",
    }),
  ).toEqual({ ok: false, error: 'Only team lead "lead-1" can assign tasks' });
  expect(manager.getTeam("alpha")?.tasks.get("task-1")).toBeUndefined();
});

test("TeamCreate and TeamDelete tools expose manager operations", async () => {
  const manager = createTeamManager();
  const createTool = createTeamCreateTool(manager);
  const deleteTool = createTeamDeleteTool(manager);

  expect(createTool.descriptor.name).toBe("TeamCreate");
  expect(deleteTool.descriptor.name).toBe("TeamDelete");

  expect(
    await createTool.execute({
      name: "alpha",
      lead: { agent_id: "lead-1", agent_name: "team-lead" },
      teammates: [
        {
          agent_id: "worker-1",
          agent_name: "coder",
          plan_mode_required: true,
        },
      ],
    }),
  ).toEqual({
    ok: true,
    team: {
      name: "alpha",
      leadAgentId: "lead-1",
      members: [
        { agentId: "lead-1", agentName: "team-lead", role: "lead", planModeRequired: false },
        { agentId: "worker-1", agentName: "coder", role: "teammate", planModeRequired: true },
      ],
      taskCount: 0,
    },
  });

  expect(await deleteTool.execute({ name: "alpha" })).toEqual({ ok: true });
});

test("TeamAssignTask and TeamReportTask tools expose lead and teammate work flow", async () => {
  const manager = createTeamManager();
  await manager.createTeam({
    name: "alpha",
    lead: { agentId: "lead-1", agentName: "team-lead", role: "lead" },
    teammates: [{ agentId: "worker-1", agentName: "coder", role: "teammate" }],
  });
  const assignTool = createTeamAssignTaskTool(manager);
  const reportTool = createTeamReportTaskTool(manager);

  expect(assignTool.descriptor.name).toBe("TeamAssignTask");
  expect(reportTool.descriptor.name).toBe("TeamReportTask");

  expect(
    await assignTool.execute({
      team_name: "alpha",
      task_id: "task-1",
      assigned_by: "lead-1",
      assigned_to: "worker-1",
      description: "Implement task handoff",
    }),
  ).toEqual({ ok: true });

  expect(
    await reportTool.execute({
      team_name: "alpha",
      task_id: "task-1",
      agent_id: "worker-1",
      output: "handoff complete",
    }),
  ).toEqual({ ok: true });

  expect(manager.getTeam("alpha")?.tasks.get("task-1")?.status).toBe("completed");
});

test("team manager can seed teammates from registry-backed spawn results", async () => {
  const spawned: string[] = [];
  const manager = createTeamManager({
    spawnTeammate: async (request) => {
      spawned.push(`${request.teamName}:${request.agentName}:${String(request.planModeRequired)}`);
      return { agentId: `spawned-${request.agentName}` };
    },
  });

  expect(
    await manager.createTeam({
      name: "alpha",
      lead: { agentId: "lead-1", agentName: "team-lead", role: "lead" },
      teammates: [
        {
          agentId: "",
          agentName: "planner",
          role: "teammate",
          planModeRequired: true,
          agentType: "planner-agent",
        },
      ],
    }),
  ).toEqual({
    ok: true,
    value: {
      name: "alpha",
      leadAgentId: "lead-1",
      members: [
        { agentId: "lead-1", agentName: "team-lead", role: "lead", planModeRequired: false },
        {
          agentId: "spawned-planner",
          agentName: "planner",
          role: "teammate",
          planModeRequired: true,
          agentType: "planner-agent",
        },
      ],
      tasks: new Map(),
    },
  });
  expect(spawned).toEqual(["alpha:planner:true"]);
});

test("team manager rejects unspawned teammates without agent IDs", async () => {
  const manager = createTeamManager();

  expect(
    await manager.createTeam({
      name: "alpha",
      lead: { agentId: "lead-1", agentName: "team-lead", role: "lead" },
      teammates: [{ agentId: "", agentName: "coder", role: "teammate" }],
    }),
  ).toEqual({ ok: false, error: 'Teammate "coder" requires agentId or spawnTeammate' });
  expect(manager.getTeam("alpha")).toBeUndefined();
});

test("team manager rejects duplicate member ids during team creation", async () => {
  const manager = createTeamManager();

  expect(
    await manager.createTeam({
      name: "alpha",
      lead: { agentId: "lead-1", agentName: "team-lead", role: "lead" },
      teammates: [
        { agentId: "worker-1", agentName: "coder-a", role: "teammate" },
        { agentId: "worker-1", agentName: "coder-b", role: "teammate" },
      ],
    }),
  ).toEqual({ ok: false, error: 'Duplicate team member agentId "worker-1"' });
  expect(manager.getTeam("alpha")).toBeUndefined();
});

test("team manager addMember rejects empty ids and additional lead roles", async () => {
  const manager = createTeamManager();
  await manager.createTeam({
    name: "alpha",
    lead: { agentId: "lead-1", agentName: "team-lead", role: "lead" },
    teammates: [],
  });

  expect(
    await manager.addMember("alpha", {
      agentId: "",
      agentName: "nameless",
      role: "teammate",
    }),
  ).toEqual({ ok: false, error: "Team member agentId must not be empty" });
  expect(
    await manager.addMember("alpha", {
      agentId: "lead-2",
      agentName: "second-lead",
      role: "lead",
    }),
  ).toEqual({ ok: false, error: "Team already has a lead" });
  expect(manager.getTeam("alpha")?.members.map((member) => member.agentId)).toEqual(["lead-1"]);
});

test("team manager rejects team creation with an empty lead id", async () => {
  const manager = createTeamManager();

  expect(
    await manager.createTeam({
      name: "alpha",
      lead: { agentId: "", agentName: "team-lead", role: "lead" },
      teammates: [],
    }),
  ).toEqual({ ok: false, error: "Team lead agentId must not be empty" });
  expect(manager.getTeam("alpha")).toBeUndefined();
});

test("team manager rejects spawn hooks that return empty teammate ids", async () => {
  const manager = createTeamManager({
    spawnTeammate: async () => ({ agentId: "" }),
  });

  expect(
    await manager.createTeam({
      name: "alpha",
      lead: { agentId: "lead-1", agentName: "team-lead", role: "lead" },
      teammates: [{ agentId: "", agentName: "coder", role: "teammate" }],
    }),
  ).toEqual({ ok: false, error: 'Spawned teammate "coder" returned empty agentId' });
  expect(manager.getTeam("alpha")).toBeUndefined();
});

test("team manager rejects blank team names", async () => {
  const manager = createTeamManager();

  expect(
    await manager.createTeam({
      name: "   ",
      lead: { agentId: "lead-1", agentName: "team-lead", role: "lead" },
      teammates: [],
    }),
  ).toEqual({ ok: false, error: "Team name must not be empty" });
  expect(manager.listTeams()).toEqual([]);
});
