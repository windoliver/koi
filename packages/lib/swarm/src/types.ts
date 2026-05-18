import type { AgentId, JsonObject, MailboxComponent, ZoneId } from "@koi/core";

export type SwarmDistributionStrategy = "round-robin" | "capability" | "load";
export type SwarmProgressStatus = "pending" | "in_progress" | "blocked" | "completed" | "failed";

export type SwarmResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export type SwarmVoidResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface SwarmTask {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly requiredCapabilities?: readonly string[] | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface SwarmTeamInput {
  readonly teamId: string;
  readonly leadAgentId: AgentId;
  readonly zoneId?: ZoneId | undefined;
  readonly leadMailbox?: MailboxComponent | undefined;
}

export interface SwarmMemberInput {
  readonly teamId: string;
  readonly agentId: AgentId;
  readonly capabilities: readonly string[];
  readonly zoneId?: ZoneId | undefined;
  readonly load?: number | undefined;
  readonly mailbox?: MailboxComponent | undefined;
}

export interface SwarmMember {
  readonly teamId: string;
  readonly agentId: AgentId;
  readonly capabilities: readonly string[];
  readonly zoneId: ZoneId;
  readonly load: number;
}

export interface SwarmTeam {
  readonly teamId: string;
  readonly leadAgentId: AgentId;
  readonly zoneId: ZoneId;
  readonly members: readonly SwarmMember[];
  readonly aborted: boolean;
  readonly abortReason?: string | undefined;
}

export interface SwarmAssignment {
  readonly teamId: string;
  readonly taskId: string;
  readonly agentId: AgentId;
  readonly strategy: SwarmDistributionStrategy;
  readonly assignedAt: number;
  readonly delegatedFromTeamId?: string | undefined;
}

export interface SwarmProgress {
  readonly teamId: string;
  readonly agentId: AgentId;
  readonly taskId: string;
  readonly status: SwarmProgressStatus;
  readonly note?: string | undefined;
  readonly completedUnits?: number | undefined;
  readonly totalUnits?: number | undefined;
}

export interface SwarmProgressInput extends SwarmProgress {}

export interface SwarmDistributeOptions {
  readonly strategy: SwarmDistributionStrategy;
}

export interface SwarmDelegateInput {
  readonly fromTeamId: string;
  readonly toTeamId: string;
  readonly task: SwarmTask;
  readonly strategy: SwarmDistributionStrategy;
}

export interface SwarmFederationBridge {
  readonly publish: (event: JsonObject) => Promise<SwarmVoidResult>;
}

export interface SwarmAbortMemberInput {
  readonly teamId: string;
  readonly agentId: AgentId;
  readonly reason: string;
}

export interface SwarmCoordinatorConfig {
  readonly localZoneId: ZoneId;
  readonly federation?: SwarmFederationBridge | undefined;
  readonly abortMember?:
    | ((input: SwarmAbortMemberInput) => Promise<SwarmVoidResult> | SwarmVoidResult)
    | undefined;
  readonly now?: (() => number) | undefined;
}

export interface SwarmCoordinator {
  readonly registerTeam: (input: SwarmTeamInput) => SwarmVoidResult;
  readonly registerMember: (input: SwarmMemberInput) => SwarmVoidResult;
  readonly getTeam: (teamId: string) => SwarmTeam | undefined;
  readonly distributeTask: (
    teamId: string,
    task: SwarmTask,
    options: SwarmDistributeOptions,
  ) => Promise<SwarmResult<AgentId>>;
  readonly delegateTask: (input: SwarmDelegateInput) => Promise<SwarmResult<AgentId>>;
  readonly updateProgress: (input: SwarmProgressInput) => SwarmVoidResult;
  readonly getProgress: (teamId: string, agentId: AgentId) => SwarmProgress | undefined;
  readonly getAssignments: (teamId: string) => readonly SwarmAssignment[];
  readonly abortTeam: (teamId: string, reason: string) => Promise<SwarmVoidResult>;
}
