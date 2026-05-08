import type { AgentId, ContentBlock, InboundMessage, SessionId } from "@koi/core";

export interface AgentWorkflowConfig {
  readonly agentId: AgentId;
  /**
   * Session identity for this workflow execution. When omitted (the default
   * for scheduled spawns), the workflow synthesizes a per-execution identity
   * from `workflowInfo().workflowId` + `runId` so each cron firing gets an
   * independent session-scoped state namespace.
   */
  readonly sessionId?: SessionId | undefined;
  readonly stateRefs: AgentStateRefs;
  readonly gatewayUrl?: string | undefined;
  readonly initialMessage?: IncomingMessage | undefined;
  readonly initialMessages?: readonly IncomingMessage[] | undefined;
  readonly initialScheduledInput?: ScheduledInputPayload | undefined;
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
  readonly maxStopRetries?: number | undefined;
  readonly nexusApiKey?: string | undefined;
  readonly delegationId?: string | undefined;
  /**
   * Spawn-request constraints carried from the parent. The activity passes
   * these into createEngineInput so the child engine enforces the same
   * trust/cost boundary the in-process spawn path applies.
   */
  readonly maxTurns?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly nonInteractive?: boolean | undefined;
  readonly toolAllowlist?: readonly string[] | undefined;
  readonly toolDenylist?: readonly string[] | undefined;
  readonly fork?: boolean | undefined;
  readonly allowNestedSpawn?: boolean | undefined;
}

export interface SpawnChildRequest {
  readonly childAgentId: AgentId;
  readonly childConfig: Omit<WorkerWorkflowConfig, "agentId" | "sessionId" | "parentAgentId">;
  /**
   * Constraints carried from the originating SpawnRequest. The child workflow
   * enforces these to preserve trust-boundary and cost-control guarantees that
   * the in-process spawn path applies. Optional fields default to the parent
   * agent's manifest configuration.
   */
  readonly constraints?:
    | {
        readonly maxTurns?: number | undefined;
        readonly maxTokens?: number | undefined;
        readonly nonInteractive?: boolean | undefined;
        readonly toolAllowlist?: readonly string[] | undefined;
        readonly toolDenylist?: readonly string[] | undefined;
        readonly fork?: boolean | undefined;
        readonly allowNestedSpawn?: boolean | undefined;
      }
    | undefined;
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
  readonly maxStopRetries?: number | undefined;
  readonly nexusApiKey?: string | undefined;
  readonly delegationId?: string | undefined;
  /** Spawn-request constraints enforced by the child workflow runtime. */
  readonly maxTurns?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly nonInteractive?: boolean | undefined;
  readonly toolAllowlist?: readonly string[] | undefined;
  readonly toolDenylist?: readonly string[] | undefined;
  readonly fork?: boolean | undefined;
  readonly allowNestedSpawn?: boolean | undefined;
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
