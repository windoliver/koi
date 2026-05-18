import type { AgentId, JsonObject, MailboxComponent, ZoneId } from "@koi/core";
import type {
  SwarmAssignment,
  SwarmCoordinator,
  SwarmCoordinatorConfig,
  SwarmDelegateInput,
  SwarmDistributionStrategy,
  SwarmMember,
  SwarmMemberInput,
  SwarmProgress,
  SwarmProgressInput,
  SwarmResult,
  SwarmTask,
  SwarmTeam,
  SwarmTeamInput,
  SwarmVoidResult,
} from "./types.js";

interface MutableSwarmTeam {
  readonly teamId: string;
  readonly leadAgentId: AgentId;
  readonly zoneId: ZoneId;
  readonly members: Map<string, SwarmMember>;
  aborted: boolean;
  abortReason?: string | undefined;
}

function okVoid(): SwarmVoidResult {
  return { ok: true };
}

function fail(error: string): { readonly ok: false; readonly error: string } {
  return { ok: false, error };
}

function value<T>(item: T): SwarmResult<T> {
  return { ok: true, value: item };
}

function cloneTeam(team: MutableSwarmTeam): SwarmTeam {
  return {
    teamId: team.teamId,
    leadAgentId: team.leadAgentId,
    zoneId: team.zoneId,
    members: Array.from(team.members.values()).map((member) => ({ ...member })),
    aborted: team.aborted,
    ...(team.abortReason !== undefined ? { abortReason: team.abortReason } : {}),
  };
}

function setMemberLoad(team: MutableSwarmTeam, member: SwarmMember, load: number): void {
  team.members.set(member.agentId, { ...member, load });
}

function assignmentLoadKey(teamId: string, agentId: AgentId, taskId: string): string {
  return `${teamId}:${agentId}:${taskId}`;
}

function isTerminalStatus(status: SwarmProgress["status"]): boolean {
  return status === "completed" || status === "failed";
}

function hasCapabilities(member: SwarmMember, required: readonly string[]): boolean {
  if (required.length === 0) return true;
  const available = new Set(member.capabilities);
  return required.every((capability) => available.has(capability));
}

function sortByAgentId(members: readonly SwarmMember[]): readonly SwarmMember[] {
  return [...members].sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function selectMember(
  team: MutableSwarmTeam,
  task: SwarmTask,
  strategy: SwarmDistributionStrategy,
  roundRobinOffsets: Map<string, number>,
): SwarmMember | undefined {
  const required = task.requiredCapabilities ?? [];
  const eligible = Array.from(team.members.values()).filter((member) =>
    hasCapabilities(member, required),
  );
  if (eligible.length === 0) return undefined;

  if (strategy === "load") {
    return [...eligible].sort((a, b) => a.load - b.load || a.agentId.localeCompare(b.agentId))[0];
  }

  if (strategy === "capability") {
    return [...sortByAgentId(eligible)].sort(
      (a, b) => b.capabilities.length - a.capabilities.length || a.agentId.localeCompare(b.agentId),
    )[0];
  }

  const offset = roundRobinOffsets.get(team.teamId) ?? 0;
  const selected = eligible[offset % eligible.length];
  roundRobinOffsets.set(team.teamId, offset + 1);
  return selected;
}

function assignmentPayload(
  team: MutableSwarmTeam,
  task: SwarmTask,
  member: SwarmMember,
  delegatedFromTeamId: string | undefined,
): JsonObject {
  return {
    teamId: team.teamId,
    taskId: task.id,
    subject: task.subject,
    description: task.description,
    agentId: member.agentId,
    ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
    ...(delegatedFromTeamId !== undefined ? { delegatedFromTeamId } : {}),
  };
}

async function sendLocalAssignment(
  sender: MailboxComponent | undefined,
  senderAgentId: AgentId,
  member: SwarmMember,
  payload: JsonObject,
): Promise<SwarmVoidResult> {
  if (sender === undefined) return okVoid();
  const sent = await sender.send({
    from: senderAgentId,
    to: member.agentId,
    kind: "event",
    type: "swarm.task.assigned",
    payload,
  });
  return sent.ok ? okVoid() : fail(sent.error.message);
}

export function createSwarmCoordinator(config: SwarmCoordinatorConfig): SwarmCoordinator {
  const teams = new Map<string, MutableSwarmTeam>();
  const mailboxes = new Map<string, MailboxComponent>();
  const progress = new Map<string, SwarmProgress>();
  const assignments = new Map<string, SwarmAssignment[]>();
  const activeAssignmentLoads = new Set<string>();
  const roundRobinOffsets = new Map<string, number>();
  const now = config.now ?? (() => Date.now());

  function progressKey(teamId: string, agentId: AgentId): string {
    return `${teamId}:${agentId}`;
  }

  function releaseAssignmentLoad(team: MutableSwarmTeam, agentId: AgentId, taskId: string): void {
    const key = assignmentLoadKey(team.teamId, agentId, taskId);
    if (!activeAssignmentLoads.has(key)) return;
    const member = team.members.get(agentId);
    if (member !== undefined) setMemberLoad(team, member, Math.max(0, member.load - 1));
    activeAssignmentLoads.delete(key);
  }

  async function publishRemoteAssignment(
    team: MutableSwarmTeam,
    task: SwarmTask,
    member: SwarmMember,
    delegatedFromTeamId: string | undefined,
  ): Promise<SwarmVoidResult> {
    if (config.federation === undefined) {
      return fail(`Federation is not configured for remote team "${team.teamId}"`);
    }
    return config.federation.publish({
      kind: "swarm.task.assigned",
      targetZoneId: member.zoneId,
      teamId: team.teamId,
      agentId: member.agentId,
      taskId: task.id,
      subject: task.subject,
      description: task.description,
      ...(delegatedFromTeamId !== undefined ? { delegatedFromTeamId } : {}),
    });
  }

  async function assignTask(
    teamId: string,
    task: SwarmTask,
    strategy: SwarmDistributionStrategy,
    delegatedFromTeamId?: string | undefined,
  ): Promise<SwarmResult<AgentId>> {
    const team = teams.get(teamId);
    if (team === undefined) return fail(`Team "${teamId}" does not exist`);
    if (team.aborted) return fail(`Team "${teamId}" is aborted`);

    const selected = selectMember(team, task, strategy, roundRobinOffsets);
    if (selected === undefined) {
      return fail(`No eligible swarm member in team "${teamId}" for task "${task.id}"`);
    }

    const delivery =
      selected.zoneId === config.localZoneId
        ? await sendLocalAssignment(
            mailboxes.get(team.leadAgentId),
            team.leadAgentId,
            selected,
            assignmentPayload(team, task, selected, delegatedFromTeamId),
          )
        : await publishRemoteAssignment(team, task, selected, delegatedFromTeamId);
    if (!delivery.ok) return delivery;
    setMemberLoad(team, selected, selected.load + 1);
    activeAssignmentLoads.add(assignmentLoadKey(teamId, selected.agentId, task.id));

    const record: SwarmAssignment = {
      teamId,
      taskId: task.id,
      agentId: selected.agentId,
      strategy,
      assignedAt: now(),
      ...(delegatedFromTeamId !== undefined ? { delegatedFromTeamId } : {}),
    };
    assignments.set(teamId, [...(assignments.get(teamId) ?? []), record]);
    return value(selected.agentId);
  }

  return {
    registerTeam(input: SwarmTeamInput): SwarmVoidResult {
      if (input.teamId.trim().length === 0) return fail("Team id must not be empty");
      if (teams.has(input.teamId)) return fail(`Team "${input.teamId}" already exists`);
      const zoneId = input.zoneId ?? config.localZoneId;
      const team: MutableSwarmTeam = {
        teamId: input.teamId,
        leadAgentId: input.leadAgentId,
        zoneId,
        members: new Map(),
        aborted: false,
      };
      teams.set(input.teamId, team);
      if (input.leadMailbox !== undefined) mailboxes.set(input.leadAgentId, input.leadMailbox);
      return okVoid();
    },

    registerMember(input: SwarmMemberInput): SwarmVoidResult {
      const team = teams.get(input.teamId);
      if (team === undefined) return fail(`Team "${input.teamId}" does not exist`);
      if (team.members.has(input.agentId)) {
        return fail(`Agent "${input.agentId}" is already in team "${input.teamId}"`);
      }
      const member: SwarmMember = {
        teamId: input.teamId,
        agentId: input.agentId,
        capabilities: [...input.capabilities],
        zoneId: input.zoneId ?? team.zoneId,
        load: input.load ?? 0,
      };
      team.members.set(input.agentId, member);
      if (input.mailbox !== undefined) mailboxes.set(input.agentId, input.mailbox);
      return okVoid();
    },

    getTeam(teamId: string): SwarmTeam | undefined {
      const team = teams.get(teamId);
      return team === undefined ? undefined : cloneTeam(team);
    },

    distributeTask(teamId, task, options) {
      return assignTask(teamId, task, options.strategy);
    },

    delegateTask(input: SwarmDelegateInput) {
      if (!teams.has(input.fromTeamId))
        return Promise.resolve(fail(`Team "${input.fromTeamId}" does not exist`));
      return assignTask(input.toTeamId, input.task, input.strategy, input.fromTeamId);
    },

    updateProgress(input: SwarmProgressInput): SwarmVoidResult {
      const team = teams.get(input.teamId);
      if (team === undefined) return fail(`Team "${input.teamId}" does not exist`);
      if (!team.members.has(input.agentId)) {
        return fail(`Agent "${input.agentId}" is not in team "${input.teamId}"`);
      }
      progress.set(progressKey(input.teamId, input.agentId), { ...input });
      if (isTerminalStatus(input.status)) {
        releaseAssignmentLoad(team, input.agentId, input.taskId);
      }
      return okVoid();
    },

    getProgress(teamId: string, agentId: AgentId): SwarmProgress | undefined {
      const item = progress.get(progressKey(teamId, agentId));
      return item === undefined ? undefined : { ...item };
    },

    getAssignments(teamId: string): readonly SwarmAssignment[] {
      return (assignments.get(teamId) ?? []).map((assignment) => ({ ...assignment }));
    },

    async abortTeam(teamId: string, reason: string): Promise<SwarmVoidResult> {
      const team = teams.get(teamId);
      if (team === undefined) return fail(`Team "${teamId}" does not exist`);
      team.aborted = true;
      team.abortReason = reason;
      for (const member of team.members.values()) {
        const result = await config.abortMember?.({ teamId, agentId: member.agentId, reason });
        if (result !== undefined && !result.ok) return result;
        const sender = mailboxes.get(team.leadAgentId);
        if (member.zoneId === config.localZoneId && sender !== undefined) {
          const sent = await sender.send({
            from: team.leadAgentId,
            to: member.agentId,
            kind: "cancel",
            type: "swarm.abort",
            payload: { teamId, reason },
          });
          if (!sent.ok) return fail(sent.error.message);
        } else if (member.zoneId !== config.localZoneId && config.federation !== undefined) {
          const published = await config.federation.publish({
            kind: "swarm.abort",
            targetZoneId: member.zoneId,
            teamId,
            agentId: member.agentId,
            reason,
          });
          if (!published.ok) return published;
        }
      }
      return okVoid();
    },
  };
}
