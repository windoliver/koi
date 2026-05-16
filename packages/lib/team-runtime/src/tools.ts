import type {
  JsonObject,
  TeamManager,
  TeamMember,
  TeamMemberRole,
  TeamRecord,
  TeamTool,
} from "./manager.js";

const TEAM_TOOL_POLICY = {
  sandbox: true,
  capabilities: {
    network: { allow: false },
    filesystem: { read: ["/tmp"], write: ["/tmp/koi-sandbox-*"] },
    resources: { maxMemoryMb: 512, timeoutMs: 30_000, maxPids: 64, maxOpenFiles: 256 },
  },
} as const;

export interface TeamSummary {
  readonly name: string;
  readonly leadAgentId: string;
  readonly members: readonly TeamMember[];
  readonly taskCount: number;
}

function summarizeTeam(team: TeamRecord): TeamSummary {
  return {
    name: team.name,
    leadAgentId: team.leadAgentId,
    members: team.members,
    taskCount: team.tasks.size,
  };
}

function readString(obj: JsonObject, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readMember(value: unknown, role: TeamMemberRole): TeamMember | undefined {
  const obj = isJsonObject(value) ? value : undefined;
  if (obj === undefined) return undefined;
  const agentId = readString(obj, "agent_id");
  const agentName = readString(obj, "agent_name");
  if (agentId === undefined || agentName === undefined) return undefined;
  return {
    agentId,
    agentName,
    role,
    planModeRequired: obj.plan_mode_required === true,
    ...(typeof obj.agent_type === "string" ? { agentType: obj.agent_type } : {}),
  };
}

function teamCreateSchema(): JsonObject {
  const memberSchema = {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      agent_name: { type: "string" },
      plan_mode_required: { type: "boolean" },
      agent_type: { type: "string" },
    },
    required: ["agent_id", "agent_name"],
  };

  return {
    type: "object",
    properties: {
      name: { type: "string" },
      lead: memberSchema,
      teammates: { type: "array", items: memberSchema },
    },
    required: ["name", "lead"],
  };
}

function teamDeleteSchema(): JsonObject {
  return {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  };
}

function teamAssignTaskSchema(): JsonObject {
  return {
    type: "object",
    properties: {
      team_name: { type: "string" },
      task_id: { type: "string" },
      assigned_by: { type: "string" },
      assigned_to: { type: "string" },
      description: { type: "string" },
    },
    required: ["team_name", "task_id", "assigned_by", "assigned_to", "description"],
  };
}

function teamReportTaskSchema(): JsonObject {
  return {
    type: "object",
    properties: {
      team_name: { type: "string" },
      task_id: { type: "string" },
      agent_id: { type: "string" },
      output: { type: "string" },
    },
    required: ["team_name", "task_id", "agent_id", "output"],
  };
}

export function createTeamCreateTool(manager: TeamManager): TeamTool {
  return {
    descriptor: {
      name: "TeamCreate",
      description: "Create a multi-agent team with one lead and zero or more teammates.",
      inputSchema: teamCreateSchema(),
      origin: "primordial",
    },
    origin: "primordial",
    policy: TEAM_TOOL_POLICY,
    execute: async (args) => {
      const name = readString(args, "name");
      const lead = readMember(args.lead, "lead");
      const teammatesRaw = Array.isArray(args.teammates) ? args.teammates : [];
      const teammates = teammatesRaw
        .map((member) => readMember(member, "teammate"))
        .filter((member): member is TeamMember => member !== undefined);
      if (name === undefined || lead === undefined) {
        return { ok: false, error: "TeamCreate requires name and lead" };
      }
      if (teammates.length !== teammatesRaw.length) {
        return { ok: false, error: "TeamCreate teammate entries require agent_id and agent_name" };
      }
      const result = await manager.createTeam({ name, lead, teammates });
      if (!result.ok) return result;
      return { ok: true, team: summarizeTeam(result.value) };
    },
  };
}

export function createTeamDeleteTool(manager: TeamManager): TeamTool {
  return {
    descriptor: {
      name: "TeamDelete",
      description: "Delete a team and remove all membership and task assignment state.",
      inputSchema: teamDeleteSchema(),
      origin: "primordial",
    },
    origin: "primordial",
    policy: TEAM_TOOL_POLICY,
    execute: async (args) => {
      const name = readString(args, "name");
      if (name === undefined) return { ok: false, error: "TeamDelete requires name" };
      return manager.deleteTeam(name);
    },
  };
}

export function createTeamAssignTaskTool(manager: TeamManager): TeamTool {
  return {
    descriptor: {
      name: "TeamAssignTask",
      description: "Assign a team task from a lead to a teammate.",
      inputSchema: teamAssignTaskSchema(),
      origin: "primordial",
    },
    origin: "primordial",
    policy: TEAM_TOOL_POLICY,
    execute: async (args) => {
      const teamName = readString(args, "team_name");
      const taskId = readString(args, "task_id");
      const assignedBy = readString(args, "assigned_by");
      const assignedTo = readString(args, "assigned_to");
      const description = readString(args, "description");
      if (
        teamName === undefined ||
        taskId === undefined ||
        assignedBy === undefined ||
        assignedTo === undefined ||
        description === undefined
      ) {
        return {
          ok: false,
          error:
            "TeamAssignTask requires team_name, task_id, assigned_by, assigned_to, and description",
        };
      }
      return manager.assignTask(teamName, { taskId, assignedBy, assignedTo, description });
    },
  };
}

export function createTeamReportTaskTool(manager: TeamManager): TeamTool {
  return {
    descriptor: {
      name: "TeamReportTask",
      description: "Report a teammate's assigned task result back to the team.",
      inputSchema: teamReportTaskSchema(),
      origin: "primordial",
    },
    origin: "primordial",
    policy: TEAM_TOOL_POLICY,
    execute: async (args) => {
      const teamName = readString(args, "team_name");
      const taskId = readString(args, "task_id");
      const agentId = readString(args, "agent_id");
      const output = readString(args, "output");
      if (
        teamName === undefined ||
        taskId === undefined ||
        agentId === undefined ||
        output === undefined
      ) {
        return {
          ok: false,
          error: "TeamReportTask requires team_name, task_id, agent_id, and output",
        };
      }
      return manager.reportTask(teamName, { taskId, agentId, output });
    },
  };
}
