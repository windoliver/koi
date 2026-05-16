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

function errorResult(error: unknown): { readonly ok: false; readonly error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

async function createTeamRecord(
  teams: Map<string, MutableTeamRecord>,
  input: TeamCreateInput,
  spawnTeammate: TeamManagerConfig["spawnTeammate"],
): Promise<TeamValueResult<TeamRecord>> {
  if (input.name.trim().length === 0) return { ok: false, error: "Team name must not be empty" };
  if (teams.has(input.name)) return { ok: false, error: `Team "${input.name}" already exists` };
  const lead = normalizeMember({ ...input.lead, role: "lead" });
  if (lead.agentId.trim().length === 0) {
    return { ok: false, error: "Team lead agentId must not be empty" };
  }
  try {
    const resolvedTeammates = await Promise.all(
      input.teammates.map((member) => resolveTeammate(input.name, member, spawnTeammate)),
    );
    const duplicateMemberId = findDuplicateMemberId([lead, ...resolvedTeammates]);
    if (duplicateMemberId !== undefined) {
      return { ok: false, error: `Duplicate team member agentId "${duplicateMemberId}"` };
    }
    const memberEntries = resolvedTeammates.map((member) => [member.agentId, member] as const);
    const team = {
      name: input.name,
      leadAgentId: lead.agentId,
      members: new Map<string, TeamMember>([[lead.agentId, lead], ...memberEntries]),
      tasks: new Map<string, TeamTaskRecord>(),
    };
    teams.set(input.name, team);
    return { ok: true, value: toTeamRecord(team) };
  } catch (error: unknown) {
    return errorResult(error);
  }
}

async function addTeamMember(
  teams: Map<string, MutableTeamRecord>,
  teamName: string,
  member: TeamMember,
): Promise<TeamVoidResult> {
  try {
    const team = findTeam(teams, teamName);
    if (member.agentId.trim().length === 0)
      return { ok: false, error: "Team member agentId must not be empty" };
    if (member.role === "lead") return { ok: false, error: "Team already has a lead" };
    if (team.members.has(member.agentId)) {
      return { ok: false, error: `Agent "${member.agentId}" is already in team "${teamName}"` };
    }
    const nextMembers = new Map(team.members);
    nextMembers.set(member.agentId, normalizeMember(member));
    teams.set(teamName, { ...team, members: nextMembers });
    return okVoid();
  } catch (error: unknown) {
    return errorResult(error);
  }
}

async function removeTeamMember(
  teams: Map<string, MutableTeamRecord>,
  teamName: string,
  agentId: string,
): Promise<TeamVoidResult> {
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
    return errorResult(error);
  }
}

async function assignTeamTask(
  teams: Map<string, MutableTeamRecord>,
  teamName: string,
  assignment: TeamTaskAssignment,
): Promise<TeamVoidResult> {
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
    return errorResult(error);
  }
}

async function reportTeamTask(
  teams: Map<string, MutableTeamRecord>,
  teamName: string,
  report: TeamTaskReport,
): Promise<TeamVoidResult> {
  try {
    const team = findTeam(teams, teamName);
    const task = team.tasks.get(report.taskId);
    if (task === undefined) return { ok: false, error: `Task "${report.taskId}" does not exist` };
    if (task.assignedTo !== report.agentId) {
      return { ok: false, error: `Task "${report.taskId}" is not assigned to "${report.agentId}"` };
    }
    team.tasks.set(report.taskId, { ...task, status: "completed", output: report.output });
    return okVoid();
  } catch (error: unknown) {
    return errorResult(error);
  }
}

export function createTeamManager(config: TeamManagerConfig = {}): TeamManager {
  const teams = new Map<string, MutableTeamRecord>();

  return {
    createTeam: (input) => createTeamRecord(teams, input, config.spawnTeammate),
    deleteTeam: async (name) =>
      teams.delete(name) ? okVoid() : { ok: false, error: `Team "${name}" does not exist` },
    getTeam: (name) => {
      const team = teams.get(name);
      return team === undefined ? undefined : toTeamRecord(team);
    },
    listTeams: () => Array.from(teams.values()).map(toTeamRecord),
    addMember: (teamName, member) => addTeamMember(teams, teamName, member),
    removeMember: (teamName, agentId) => removeTeamMember(teams, teamName, agentId),
    assignTask: (teamName, assignment) => assignTeamTask(teams, teamName, assignment),
    reportTask: (teamName, report) => reportTeamTask(teams, teamName, report),
  };
}
