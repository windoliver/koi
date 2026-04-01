/**
 * L2-local configuration and interface types for @koi/long-running.
 *
 * These types are internal to the package — L0 types live in @koi/core/harness.
 */

import type {
  AgentId,
  AgentRegistry,
  EngineInput,
  EngineMetrics,
  EngineState,
  HarnessId,
  HarnessSnapshotStore,
  HarnessStatus,
  KoiError,
  KoiMiddleware,
  PruningPolicy,
  Result,
  SessionPersistence,
  TaskBoardSnapshot,
  TaskItemId,
  TaskResult,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Lifecycle callbacks
// ---------------------------------------------------------------------------

/**
 * Called when the harness transitions to "completed" (all tasks done).
 * Receives the final HarnessStatus snapshot. Errors are caught and logged
 * — they never prevent the completion from succeeding.
 */
export type OnCompletedCallback = (status: HarnessStatus) => void | Promise<void>;

/**
 * Called when the harness transitions to "failed".
 * Receives the final HarnessStatus snapshot and the triggering error.
 * Errors are caught and logged — they never prevent the failure from recording.
 */
export type OnFailedCallback = (status: HarnessStatus, error: KoiError) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Save-state callback for soft checkpoints
// ---------------------------------------------------------------------------

/** Optional callback to capture real engine state during soft checkpoints. */
export type SaveStateCallback = () => EngineState | Promise<EngineState>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LongRunningConfig {
  readonly harnessId: HarnessId;
  readonly agentId: AgentId;
  readonly harnessStore: HarnessSnapshotStore;
  readonly sessionPersistence: SessionPersistence;
  readonly softCheckpointInterval?: number | undefined;
  readonly maxKeyArtifacts?: number | undefined;
  readonly maxContextTokens?: number | undefined;
  readonly artifactToolNames?: readonly string[] | undefined;
  readonly pruningPolicy?: PruningPolicy | undefined;
  readonly saveState?: SaveStateCallback | undefined;
  /** Optional agent registry for CAS-based lifecycle transitions. */
  readonly registry?: AgentRegistry | undefined;
  /** Called when the harness transitions to "completed". Best-effort — errors are logged, not propagated. */
  readonly onCompleted?: OnCompletedCallback | undefined;
  /** Called when the harness transitions to "failed". Best-effort — errors are logged, not propagated. */
  readonly onFailed?: OnFailedCallback | undefined;
}

// ---------------------------------------------------------------------------
// Harness interface
// ---------------------------------------------------------------------------

export interface LongRunningHarness {
  readonly harnessId: HarnessId;
  readonly start: (taskPlan: TaskBoardSnapshot) => Promise<Result<StartResult, KoiError>>;
  readonly resume: () => Promise<Result<ResumeResult, KoiError>>;
  readonly pause: (sessionResult: SessionResult) => Promise<Result<void, KoiError>>;
  readonly fail: (error: KoiError) => Promise<Result<void, KoiError>>;
  /** Transition a task from "pending" to "assigned" for spawn delegation. */
  readonly assignTask: (taskId: TaskItemId, agentId: AgentId) => Promise<Result<void, KoiError>>;
  readonly completeTask: (
    taskId: TaskItemId,
    result: TaskResult,
  ) => Promise<Result<void, KoiError>>;
  /** Mark an assigned task as failed. Retryable errors go back to pending. */
  readonly failTask: (taskId: TaskItemId, error: KoiError) => Promise<Result<void, KoiError>>;
  readonly status: () => HarnessStatus;
  readonly createMiddleware: () => KoiMiddleware;
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Operation results
// ---------------------------------------------------------------------------

export interface StartResult {
  readonly engineInput: EngineInput;
  readonly sessionId: string;
}

export interface ResumeResult {
  readonly engineInput: EngineInput;
  readonly sessionId: string;
  readonly engineStateRecovered: boolean;
}

export interface SessionResult {
  readonly sessionId: string;
  readonly engineState?: EngineState | undefined;
  readonly metrics: EngineMetrics;
  readonly summary?: string | undefined;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_LONG_RUNNING_CONFIG = {
  softCheckpointInterval: 5,
  maxKeyArtifacts: 10,
  maxContextTokens: 3000,
  pruningPolicy: { retainCount: 10 } as PruningPolicy,
} as const;
