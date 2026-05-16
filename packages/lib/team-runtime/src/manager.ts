export type JsonObject = Readonly<Record<string, unknown>>;

export interface TeamTool {
  readonly descriptor: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonObject;
    readonly origin: "primordial" | "operator" | "forged";
  };
  readonly origin: "primordial" | "operator" | "forged";
  readonly policy: {
    readonly sandbox: boolean;
    readonly capabilities: JsonObject;
  };
  readonly execute: (args: JsonObject) => Promise<unknown>;
}

const TEAM_TOOL_POLICY = {
  sandbox: true,
  capabilities: {
    network: { allow: false },
    filesystem: { read: ["/tmp"], write: ["/tmp/koi-sandbox-*"] },
    resources: { maxMemoryMb: 512, timeoutMs: 30_000, maxPids: 64, maxOpenFiles: 256 },
  },
} as const;

export type TeamMemberRole = "lead" | "teammate";
export type TeamTaskStatus = "assigned" | "completed";

export interface TeamMember {
  readonly agentId: string;
  readonly agentName: string;
  readonly role: TeamMemberRole;
  readonly planModeRequired?: boolean | undefined;
  readonly agentType?: string | undefined;
}

export interface TeamTaskAssignment {
  readonly taskId: string;
  readonly assignedBy: string;
  readonly assignedTo: string;
  readonly description: string;
}

export interface TeamTaskRecord extends TeamTaskAssignment {
  readonly status: TeamTaskStatus;
  readonly output?: string | undefined;
}

export interface TeamRecord {
  readonly name: string;
  readonly leadAgentId: string;
  readonly members: readonly TeamMember[];
  readonly tasks: ReadonlyMap<string, TeamTaskRecord>;
}

export interface TeamCreateInput {
  readonly name: string;
  readonly lead: TeamMember;
  readonly teammates: readonly TeamMember[];
}

export interface TeamTaskReport {
  readonly taskId: string;
  readonly agentId: string;
  readonly output: string;
}

export interface TeamSpawnRequest {
  readonly teamName: string;
  readonly agentName: string;
  readonly agentType: string | undefined;
  readonly planModeRequired: boolean;
}

export interface TeamSpawnResult {
  readonly agentId: string;
}

export interface TeamManagerConfig {
  readonly spawnTeammate?:
    | ((request: TeamSpawnRequest) => TeamSpawnResult | Promise<TeamSpawnResult>)
    | undefined;
}

export interface TeamManager {
  readonly createTeam: (input: TeamCreateInput) => Promise<TeamValueResult<TeamRecord>>;
  readonly deleteTeam: (name: string) => Promise<TeamVoidResult>;
  readonly getTeam: (name: string) => TeamRecord | undefined;
  readonly listTeams: () => readonly TeamRecord[];
  readonly addMember: (teamName: string, member: TeamMember) => Promise<TeamVoidResult>;
  readonly removeMember: (teamName: string, agentId: string) => Promise<TeamVoidResult>;
  readonly assignTask: (
    teamName: string,
    assignment: TeamTaskAssignment,
  ) => Promise<TeamVoidResult>;
  readonly reportTask: (teamName: string, report: TeamTaskReport) => Promise<TeamVoidResult>;
}

export type TeamValueResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export type TeamVoidResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

interface MutableTeamRecord {
  readonly name: string;
  readonly leadAgentId: string;
  readonly members: ReadonlyMap<string, TeamMember>;
  readonly tasks: Map<string, TeamTaskRecord>;
}

function toTeamRecord(team: MutableTeamRecord): TeamRecord {
  return {
    name: team.name,
    leadAgentId: team.leadAgentId,
    members: Array.from(team.members.values()),
    tasks: new Map(team.tasks),
  };
}

function okVoid(): { readonly ok: true } {
  return { ok: true };
}

function findTeam(teams: ReadonlyMap<string, MutableTeamRecord>, name: string): MutableTeamRecord {
  const team = teams.get(name);
  if (team === undefined) throw new Error(`Team "${name}" does not exist`);
  return team;
}

function normalizeMember(member: TeamMember): TeamMember {
  return {
    agentId: member.agentId,
    agentName: member.agentName,
    role: member.role,
    planModeRequired: member.role === "teammate" ? member.planModeRequired === true : false,
    ...(member.agentType !== undefined ? { agentType: member.agentType } : {}),
  };
}

function findDuplicateMemberId(members: readonly TeamMember[]): string | undefined {
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.agentId)) return member.agentId;
    seen.add(member.agentId);
  }
  return undefined;
}

async function resolveTeammate(
  teamName: string,
  member: TeamMember,
  spawnTeammate: TeamManagerConfig["spawnTeammate"],
): Promise<TeamMember> {
  if (member.agentId.trim().length > 0 || spawnTeammate === undefined) {
    if (member.agentId.trim().length === 0) {
      throw new Error(`Teammate "${member.agentName}" requires agentId or spawnTeammate`);
    }
    return normalizeMember({ ...member, role: "teammate" });
  }
  const spawned = await spawnTeammate({
    teamName,
    agentName: member.agentName,
    agentType: member.agentType,
    planModeRequired: member.planModeRequired === true,
  });
  if (spawned.agentId.trim().length === 0) {
    throw new Error(`Spawned teammate "${member.agentName}" returned empty agentId`);
  }
  return normalizeMember({ ...member, role: "teammate", agentId: spawned.agentId });
}

export function createTeamManager(config: TeamManagerConfig = {}): TeamManager {
  const teams = new Map<string, MutableTeamRecord>();

  return {
    createTeam: async (input) => {
      if (input.name.trim().length === 0) {
        return { ok: false, error: "Team name must not be empty" };
      }
      if (teams.has(input.name)) return { ok: false, error: `Team "${input.name}" already exists` };
      const lead = normalizeMember({ ...input.lead, role: "lead" });
      if (lead.agentId.trim().length === 0) {
        return { ok: false, error: "Team lead agentId must not be empty" };
      }
      let resolvedTeammates: readonly TeamMember[];
      try {
        resolvedTeammates = await Promise.all(
          input.teammates.map((member) =>
            resolveTeammate(input.name, member, config.spawnTeammate),
          ),
        );
      } catch (error: unknown) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const duplicateMemberId = findDuplicateMemberId([lead, ...resolvedTeammates]);
      if (duplicateMemberId !== undefined) {
        return { ok: false, error: `Duplicate team member agentId "${duplicateMemberId}"` };
      }
      const teammateEntries = resolvedTeammates.map((normalized) => {
        return [normalized.agentId, normalized] as const;
      });
      const members = new Map<string, TeamMember>([[lead.agentId, lead], ...teammateEntries]);
      const team: MutableTeamRecord = {
        name: input.name,
        leadAgentId: lead.agentId,
        members,
        tasks: new Map(),
      };
      teams.set(input.name, team);
      return { ok: true, value: toTeamRecord(team) };
    },
    deleteTeam: async (name) => {
      if (!teams.delete(name)) return { ok: false, error: `Team "${name}" does not exist` };
      return okVoid();
    },
    getTeam: (name) => {
      const team = teams.get(name);
      return team === undefined ? undefined : toTeamRecord(team);
    },
    listTeams: () => Array.from(teams.values()).map(toTeamRecord),
    addMember: async (teamName, member) => {
      try {
        const team = findTeam(teams, teamName);
        if (member.agentId.trim().length === 0) {
          return { ok: false, error: "Team member agentId must not be empty" };
        }
        if (member.role === "lead") {
          return { ok: false, error: "Team already has a lead" };
        }
        if (team.members.has(member.agentId)) {
          return { ok: false, error: `Agent "${member.agentId}" is already in team "${teamName}"` };
        }
        const nextMembers = new Map(team.members);
        nextMembers.set(member.agentId, normalizeMember(member));
        teams.set(teamName, { ...team, members: nextMembers });
        return okVoid();
      } catch (error: unknown) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    removeMember: async (teamName, agentId) => {
      try {
        const team = findTeam(teams, teamName);
        if (agentId === team.leadAgentId) return { ok: false, error: "Cannot remove team lead" };
        if (!team.members.has(agentId)) {
          return { ok: false, error: `Agent "${agentId}" is not in team "${teamName}"` };
        }
        const nextMembers = new Map(team.members);
        nextMembers.delete(agentId);
        teams.set(teamName, { ...team, members: nextMembers });
        return okVoid();
      } catch (error: unknown) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    assignTask: async (teamName, assignment) => {
      try {
        const team = findTeam(teams, teamName);
        if (!team.members.has(assignment.assignedBy)) {
          return { ok: false, error: `Assigner "${assignment.assignedBy}" is not in team` };
        }
        if (assignment.assignedBy !== team.leadAgentId) {
          return { ok: false, error: `Only team lead "${team.leadAgentId}" can assign tasks` };
        }
        if (!team.members.has(assignment.assignedTo)) {
          return { ok: false, error: `Assignee "${assignment.assignedTo}" is not in team` };
        }
        team.tasks.set(assignment.taskId, { ...assignment, status: "assigned" });
        return okVoid();
      } catch (error: unknown) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    reportTask: async (teamName, report) => {
      try {
        const team = findTeam(teams, teamName);
        const task = team.tasks.get(report.taskId);
        if (task === undefined)
          return { ok: false, error: `Task "${report.taskId}" does not exist` };
        if (task.assignedTo !== report.agentId) {
          return {
            ok: false,
            error: `Task "${report.taskId}" is not assigned to "${report.agentId}"`,
          };
        }
        team.tasks.set(report.taskId, { ...task, status: "completed", output: report.output });
        return okVoid();
      } catch (error: unknown) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

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
