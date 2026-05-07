import type { AgentId, ContentBlock, InboundMessage, SessionId } from "@koi/core";

export interface AgentWorkflowConfig {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly stateRefs: AgentStateRefs;
  readonly gatewayUrl?: string | undefined;
  readonly initialMessage?: IncomingMessage | undefined;
  readonly initialMessages?: readonly IncomingMessage[] | undefined;
  readonly maxStopRetries?: number | undefined;
}

export interface AgentStateRefs {
  readonly lastTurnId: string | undefined;
  readonly turnsProcessed: number;
}

export interface AgentTurnInput {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly message: IncomingMessage;
  readonly stateRefs: AgentStateRefs;
  readonly gatewayUrl: string | undefined;
  readonly nexusApiKey?: string | undefined;
  readonly delegationId?: string | undefined;
}

export interface SpawnChildRequest {
  readonly childAgentId: AgentId;
  readonly childConfig: Omit<WorkerWorkflowConfig, "agentId" | "sessionId" | "parentAgentId">;
}

export interface AgentTurnResult {
  readonly turnId: string;
  readonly blocks: readonly ContentBlock[];
  readonly updatedStateRefs: AgentStateRefs;
  readonly spawnChild: SpawnChildRequest | undefined;
}

export interface IncomingMessage {
  readonly id: string;
  readonly senderId: string;
  readonly content: readonly ContentBlock[];
  readonly timestamp: number;
  readonly threadId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly pinned?: boolean | undefined;
  readonly resumeState?: unknown | undefined;
}

type ScheduledInputBase = { readonly maxStopRetries?: number | undefined };

export type ScheduledInputPayload =
  | (ScheduledInputBase & { readonly kind: "text"; readonly text: string })
  | (ScheduledInputBase & {
      readonly kind: "messages";
      readonly messages: readonly InboundMessage[];
    })
  | (ScheduledInputBase & {
      readonly kind: "resume";
      readonly state: { readonly engineId: string; readonly data: unknown };
    });

export interface ScheduledSpawnArgs {
  readonly agentId: AgentId;
  readonly stateRefs: AgentStateRefs;
  readonly input: ScheduledInputPayload;
}

export interface WorkerWorkflowConfig {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly parentAgentId: AgentId;
  readonly stateRefs: AgentStateRefs;
  readonly gatewayUrl?: string | undefined;
  readonly initialMessage?: IncomingMessage | undefined;
  readonly nexusApiKey?: string | undefined;
  readonly delegationId?: string | undefined;
}

export interface TemporalConfig {
  readonly url: string | undefined;
  readonly taskQueue: string;
  readonly maxCachedWorkflows: number;
  readonly healthCheckIntervalMs: number;
  readonly healthFailureThreshold: number;
  readonly healthCooldownMs: number;
  readonly dbPath: string | undefined;
}

export const DEFAULT_TEMPORAL_CONFIG: TemporalConfig = Object.freeze({
  url: undefined,
  taskQueue: "koi-default",
  maxCachedWorkflows: 100,
  healthCheckIntervalMs: 10_000,
  healthFailureThreshold: 3,
  healthCooldownMs: 60_000,
  dbPath: undefined,
});
