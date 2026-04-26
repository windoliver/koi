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
  /**
   * Maximum retries per task before a retryable `failTask` becomes
   * terminal. Mirrors `TaskBoardConfig.maxRetries`. Default 3.
   *
   * Note: when the harness wraps a live task-board, `taskMaxRetries`
   * here can drift from the board's own `TaskBoardConfig.maxRetries`.
   * Pass `getTaskMaxRetries` below to bridge to the authoritative
   * board-side budget per call.
   */
  readonly taskMaxRetries?: number;
  /**
   * Optional bridge to the live task-board's retry budget. When set,
   * the harness uses this value (per-task) instead of `taskMaxRetries`
   * for `failTask` retry-exhaustion gating. Return `undefined` to fall
   * back to `taskMaxRetries`. Values are validated as non-negative
   * integers; invalid values fall back to `taskMaxRetries`.
   */
  readonly getTaskMaxRetries?: (taskId: string) => number | undefined;
  /**
   * Opt-in to recovering crashed `active` heads via `resume()`. When
   * false (default), only `suspended` heads are resumable; `active`
   * heads return CONFLICT to prevent split-brain (a still-running or
   * partitioned prior worker would emit duplicate side effects).
   * Set to `true` ONLY when the host enforces durable ownership
   * fencing (heartbeat, CAS, lease lock) outside this package and can
   * prove the prior worker is dead before invoking resume(). Active
   * resume still requires durable lastEngineState on the prior session
   * row (set by a prior soft checkpoint).
   */
  readonly allowActiveResume?: boolean;
  /**
   * Optional engine drain callback. The harness awaits this callback
   * (bounded by `abortTimeoutMs`) for an explicit acknowledgement that
   * the engine has drained.
   *
   * The callback is invoked with `{ sessionId, lease }` identifying the
   * specific execution being revoked. Implementations MUST scope drain
   * verification to that exact session so a global or shared callback
   * cannot resolve based on unrelated work and let the harness publish
   * a terminal snapshot while side effects from the revoked lease are
   * still running.
   *
   * The contract: when this callback resolves, BOTH must be true for
   * the identified session:
   *  1. The current turn has finished mutating in-memory state (no
   *     more onBeforeTurn / wrapModelCall / wrapToolCall in flight).
   *  2. All async background work tied to the revoked lease (tool
   *     execution, MCP requests, streaming side effects) has stopped.
   *
   * The harness uses this callback as the authoritative drain signal
   * AND as a wedge-override when middleware bookkeeping (`inTurn`) is
   * stuck true (e.g. the turn errored after onBeforeTurn). If the
   * callback rejects or times out, the terminal transition fails and
   * the caller can retry. Recommended for any adapter that does
   * background work (tool execution, MCP, streaming).
   */
  readonly quiesceEngine?: (ctx: {
    readonly sessionId: SessionId;
    readonly lease: SessionLease;
  }) => Promise<void>;
  /**
   * Optional compatibility hook for resuming legacy suspended heads
   * whose prior session row has no `lastEngineState`. When set and the
   * resumed prior session is missing engine state, the harness invokes
   * this callback with the prior session id and uses the returned
   * value (e.g. a transcript-replay state) as the carried engine state.
   * Return `undefined` to keep the default behavior (resume rejects
   * with NOT_FOUND).
   */
  readonly legacyResumeFallback?: (
    priorSessionId: string,
  ) => Promise<unknown | undefined> | unknown | undefined;
  /** Wall-clock deadline per session. Optional. */
  readonly timeoutMs?: number;
  /** Max wait for engine to quiesce on phase transitions. Default 10_000. */
  readonly abortTimeoutMs?: number;
  /**
   * Save engine state on soft checkpoint and at pause(). Required at
   * construction — `createLongRunningHarness` rejects with VALIDATION
   * when missing, because pause() needs durable engine-state capture
   * and the harness has no transcript-replay fallback.
   */
  readonly saveState: SaveStateCallback;
  /**
   * Best-effort observability hook fired AFTER the terminal `completed`
   * snapshot is durable. Errors thrown here are captured into
   * `failureReason` (and a follow-up annotated snapshot) but do NOT
   * convert the already-committed transition into a failure. Do NOT
   * place required side effects here — use a separate workflow keyed
   * off the durable snapshot phase.
   */
  readonly onCompleted?: OnCompletedCallback;
  /**
   * Best-effort observability hook fired AFTER the terminal `failed`
   * snapshot is durable. Same contract as `onCompleted`: thrown errors
   * are captured into `failureReason` and do not roll back the
   * transition.
   */
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
  /**
   * Publish phase=completed without requiring a tracked task. Use this
   * when the harness does not maintain a task board and the caller has
   * an externally-determined success signal. For task-board-tracked
   * runs, prefer `completeTask` so the last task transition triggers
   * the terminal flow automatically.
   */
  readonly complete: (lease: SessionLease) => Promise<Result<void, KoiError>>;
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
