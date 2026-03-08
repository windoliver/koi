/**
 * Internal types for @koi/temporal.
 *
 * These types are NOT exported from the public API — they are internal
 * to the Temporal integration and must never leak to L0/L1.
 */

import type { AgentId, ContentBlock, SessionId } from "@koi/core";

// ---------------------------------------------------------------------------
// Workflow configuration
// ---------------------------------------------------------------------------

/** Configuration for an Entity Workflow representing a copilot agent. */
export interface AgentWorkflowConfig {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  /** Lightweight state refs — NO data, only pointers to external stores. */
  readonly stateRefs: AgentStateRefs;
}

/**
 * Lightweight references to external state stores.
 *
 * Workflow state must be <1KB for fast Continue-As-New.
 * Actual data lives in Nexus threadStore, memory-fs, ForgeStore.
 */
export interface AgentStateRefs {
  /** ID of the last completed turn (for ordering). */
  readonly lastTurnId: string | undefined;
  /** Number of turns processed in this workflow execution. */
  readonly turnsProcessed: number;
}

// ---------------------------------------------------------------------------
// Activity input/output
// ---------------------------------------------------------------------------

/** Input passed to the `runAgentTurn` Activity. */
export interface AgentTurnInput {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly message: IncomingMessage;
  readonly stateRefs: AgentStateRefs;
  /** Gateway frame sender endpoint for streaming (Decision 2A). */
  readonly gatewayUrl: string | undefined;
}

/** Result returned by the `runAgentTurn` Activity. */
export interface AgentTurnResult {
  readonly turnId: string;
  readonly blocks: readonly ContentBlock[];
  readonly updatedStateRefs: AgentStateRefs;
  /** Whether the Activity requests a child workflow spawn. */
  readonly spawnChild: SpawnChildRequest | undefined;
}

/** Request to spawn a child workflow (worker agent). */
export interface SpawnChildRequest {
  readonly childAgentId: AgentId;
  readonly childConfig: AgentWorkflowConfig;
}

// ---------------------------------------------------------------------------
// Message types (signal payloads)
// ---------------------------------------------------------------------------

/** Incoming message delivered via Temporal signal. */
export interface IncomingMessage {
  readonly id: string;
  readonly senderId: string;
  readonly content: readonly ContentBlock[];
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Temporal configuration (from koi.yaml manifest)
// ---------------------------------------------------------------------------

/** Configuration section for Temporal in the agent manifest. */
export interface TemporalConfig {
  /** Temporal server URL. Undefined = auto-start embed mode. */
  readonly url: string | undefined;
  /** Task queue name. Default: "koi-default". */
  readonly taskQueue: string;
  /** Max cached workflows in the Worker. Tuned per memory budget (Decision 14A). */
  readonly maxCachedWorkflows: number;
  /** Health check poll interval in ms. Default: 10_000. */
  readonly healthCheckIntervalMs: number;
  /** Circuit breaker failure threshold. Default: 3. */
  readonly healthFailureThreshold: number;
  /** Circuit breaker cooldown in ms. Default: 60_000. */
  readonly healthCooldownMs: number;
  /** SQLite DB path for Temporal dev server persistence. Undefined = in-memory. */
  readonly dbPath: string | undefined;
}

/** Default Temporal configuration. */
export const DEFAULT_TEMPORAL_CONFIG: TemporalConfig = Object.freeze({
  url: undefined,
  taskQueue: "koi-default",
  maxCachedWorkflows: 100,
  healthCheckIntervalMs: 10_000,
  healthFailureThreshold: 3,
  healthCooldownMs: 60_000,
  dbPath: undefined,
});

// ---------------------------------------------------------------------------
// Worker configuration (child workflow)
// ---------------------------------------------------------------------------

/** Configuration for a worker (child) workflow. */
export interface WorkerWorkflowConfig {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly parentAgentId: AgentId;
  readonly stateRefs: AgentStateRefs;
}

// ---------------------------------------------------------------------------
// Engine cache key
// ---------------------------------------------------------------------------

/** Cache key for engine instance reuse across turns (Decision 13A). */
export interface EngineCacheKey {
  readonly manifestHash: string;
  readonly forgeGeneration: number;
}
