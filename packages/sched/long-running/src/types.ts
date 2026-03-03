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
  readonly completeTask: (
    taskId: TaskItemId,
    result: TaskResult,
  ) => Promise<Result<void, KoiError>>;
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
