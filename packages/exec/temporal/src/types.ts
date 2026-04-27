import type { AgentId, ContentBlock, InboundMessage, SessionId } from "@koi/core";

export interface AgentWorkflowConfig {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly stateRefs: AgentStateRefs;
  readonly initialMessage?: IncomingMessage | undefined;
  readonly initialMessages?: readonly IncomingMessage[] | undefined;
  readonly maxStopRetries?: number | undefined;
}

// Serializable-safe payload derived from EngineInput for embedding in Temporal schedules.
// Non-durable fields from EngineInputBase (callHandlers, signal, correlationIds) are
// stripped at the scheduling boundary. maxStopRetries IS preserved — it changes agent
// runtime behavior and silently dropping it would cause stop-gated agents to terminate
// earlier than the caller requested.
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

// Args for workflows started by a cron schedule (spawn mode).
// sessionId is intentionally absent — each Temporal execution provides its own
// workflow execution ID as the session namespace, preventing cross-run state collision.
// input is a serializable ScheduledInputPayload (not a raw EngineInput) — callHandlers
// and AbortSignal are stripped before schedule creation.
export interface ScheduledSpawnArgs {
  readonly agentId: AgentId;
  readonly stateRefs: AgentStateRefs;
  readonly input: ScheduledInputPayload;
}

export interface AgentStateRefs {
  readonly lastTurnId: string | undefined;
  readonly turnsProcessed: number;
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
