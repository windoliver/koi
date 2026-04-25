import type {
  AgentId,
  ContextSummary,
  EngineInput,
  HarnessId,
  HarnessMetrics,
  HarnessSnapshotStore,
  HarnessStatus,
  KeyArtifact,
  KoiError,
  KoiMiddleware,
  PruningPolicy,
  Result,
  SessionId,
  SessionPersistence,
} from "@koi/core";

/** Capability handed to the caller after start()/resume(). Identity-checked via WeakSet. */
export interface SessionLease {
  readonly sessionId: SessionId;
  /** Monotonic per harness instance. In-memory only; useful for tool-layer epoch checks. */
  readonly epoch: number;
  /** Aborted on revocation (pause/fail/dispose/timeout). */
  readonly abort: AbortSignal;
}

export interface StartResult {
  readonly lease: SessionLease;
  readonly engineInput: EngineInput;
  readonly sessionId: SessionId;
}

export type ResumeResult = StartResult;

export interface SessionResult {
  readonly summary: ContextSummary;
  readonly newKeyArtifacts: readonly KeyArtifact[];
  readonly metricsDelta: Partial<HarnessMetrics>;
}

export type SaveStateCallback = () => Promise<unknown>;
export type OnCompletedCallback = (status: HarnessStatus) => void | Promise<void>;
export type OnFailedCallback = (status: HarnessStatus, error: KoiError) => void | Promise<void>;

export interface LongRunningConfig {
  readonly harnessId: HarnessId;
  readonly agentId: AgentId;
  readonly harnessStore: HarnessSnapshotStore;
  readonly sessionPersistence: SessionPersistence;
  /** Turns between soft checkpoints. Default 5. */
  readonly softCheckpointInterval?: number;
  /** Max key artifacts retained per harness. Default 10. */
  readonly maxKeyArtifacts?: number;
  /** Pruning policy for the snapshot chain. Default { retainCount: 10 }. */
  readonly pruningPolicy?: PruningPolicy;
  /** Wall-clock deadline per session. Optional. */
  readonly timeoutMs?: number;
  /** Max wait for engine to quiesce on phase transitions. Default 10_000. */
  readonly abortTimeoutMs?: number;
  /** Save engine state on soft checkpoint. */
  readonly saveState?: SaveStateCallback;
  /** Called when the harness completes (all tasks done). */
  readonly onCompleted?: OnCompletedCallback;
  /** Called when the harness fails. */
  readonly onFailed?: OnFailedCallback;
  /** Optional clock injection for tests. Defaults to Date.now. */
  readonly now?: () => number;
}

export interface CheckpointMiddlewareConfig {
  /** Override soft-checkpoint cadence. Defaults to harness config. */
  readonly softCheckpointInterval?: number;
}

export interface LongRunningHarness {
  readonly start: () => Promise<Result<StartResult, KoiError>>;
  readonly resume: () => Promise<Result<ResumeResult, KoiError>>;
  readonly pause: (
    lease: SessionLease,
    sessionResult: SessionResult,
  ) => Promise<Result<void, KoiError>>;
  readonly fail: (lease: SessionLease, error: KoiError) => Promise<Result<void, KoiError>>;
  readonly completeTask: (
    lease: SessionLease,
    taskId: string,
    result: unknown,
  ) => Promise<Result<void, KoiError>>;
  readonly failTask: (
    lease: SessionLease,
    taskId: string,
    error: KoiError,
  ) => Promise<Result<void, KoiError>>;
  readonly dispose: (lease?: SessionLease) => Promise<Result<void, KoiError>>;
  readonly status: () => HarnessStatus;
  readonly createMiddleware: (cfg?: CheckpointMiddlewareConfig) => KoiMiddleware;
}

export interface LongRunningDefaults {
  readonly softCheckpointInterval: number;
  readonly maxKeyArtifacts: number;
  readonly pruningPolicy: PruningPolicy;
  readonly abortTimeoutMs: number;
}

export const DEFAULT_LONG_RUNNING_CONFIG: LongRunningDefaults = {
  softCheckpointInterval: 5,
  maxKeyArtifacts: 10,
  pruningPolicy: { retainCount: 10 },
  abortTimeoutMs: 10_000,
};
