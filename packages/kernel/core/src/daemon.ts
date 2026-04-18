/**
 * Daemon contracts — WorkerBackend + Supervisor for the OS-process substrate
 * that hosts long-running agent workers.
 *
 * Sits *below* the logical supervision layer (`SupervisionConfig` +
 * `SupervisionReconciler`): the reconciler decides WHEN to restart an agent;
 * the daemon decides HOW to spawn/terminate the underlying process. The two
 * layers are independent — reconciler consumes a `SpawnFn` which, at the
 * integration boundary, delegates into a daemon `Supervisor`.
 *
 * L0 status: types/interfaces + one validator. The validator is side-effect-free
 * data validation, permitted in L0 per architecture-doc exceptions.
 */

import type { JsonObject } from "./common.js";
import type { AgentId, ProcessState } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";
import type { ProcessDescriptor } from "./process-descriptor.js";
import type { RestartType } from "./supervision.js";

// ---------------------------------------------------------------------------
// WorkerId — branded identity
// ---------------------------------------------------------------------------

declare const __workerIdBrand: unique symbol;
export type WorkerId = string & { readonly [__workerIdBrand]: "WorkerId" };
export const workerId = (s: string): WorkerId => s as WorkerId;

// ---------------------------------------------------------------------------
// WorkerBackend — swappable execution substrate
// ---------------------------------------------------------------------------

export type WorkerBackendKind = "in-process" | "subprocess" | "tmux" | "remote";

export interface WorkerBackend {
  readonly kind: WorkerBackendKind;
  readonly displayName: string;
  readonly isAvailable: () => boolean | Promise<boolean>;
  readonly spawn: (request: WorkerSpawnRequest) => Promise<Result<WorkerHandle, KoiError>>;
  readonly terminate: (id: WorkerId, reason: string) => Promise<Result<void, KoiError>>;
  readonly kill: (id: WorkerId) => Promise<Result<void, KoiError>>;
  readonly isAlive: (id: WorkerId) => Promise<boolean>;
  readonly watch: (id: WorkerId) => AsyncIterable<WorkerEvent>;
}

// ---------------------------------------------------------------------------
// Spawn request / handle
// ---------------------------------------------------------------------------

export interface WorkerSpawnRequest {
  readonly workerId: WorkerId;
  readonly agentId: AgentId;
  readonly command: readonly string[];
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string | null>> | undefined;
  readonly backendHints?: JsonObject | undefined;
}

export interface WorkerHandle {
  readonly workerId: WorkerId;
  readonly agentId: AgentId;
  readonly backendKind: WorkerBackendKind;
  readonly startedAt: number;
  readonly signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// Worker events
// ---------------------------------------------------------------------------

export type WorkerEvent =
  | {
      readonly kind: "started";
      readonly workerId: WorkerId;
      readonly at: number;
      /**
       * OS process identity for backends that have one (subprocess, tmux).
       * Omitted by backends that lack a PID (in-process, some remote).
       * Registry bridges that care about PID-based kill MUST propagate
       * this into the session record on every respawn — without it, a
       * restarted worker's registry entry keeps the pre-restart PID and
       * `bg kill` can signal a reused PID.
       */
      readonly pid?: number;
    }
  | { readonly kind: "heartbeat"; readonly workerId: WorkerId; readonly at: number }
  | {
      readonly kind: "exited";
      readonly workerId: WorkerId;
      readonly at: number;
      readonly code: number;
      readonly state: ProcessState;
    }
  | {
      readonly kind: "crashed";
      readonly workerId: WorkerId;
      readonly at: number;
      readonly error: KoiError;
    };

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

export interface SupervisorConfig {
  readonly maxWorkers: number;
  readonly shutdownDeadlineMs: number;
  readonly backends: Readonly<Partial<Record<WorkerBackendKind, WorkerBackend>>>;
  readonly restart?: WorkerRestartPolicy | undefined;
  /**
   * Maximum time to wait for `backend.spawn()` to resolve. A spawn that
   * exceeds this timeout is considered hung: the capacity reservation is
   * released, start() returns TIMEOUT, and if the spawn ever resolves
   * afterward the resulting worker is terminated/killed so it cannot
   * consume supervisor capacity.
   *
   * Defaults to 30_000ms. Set to 0 to disable (not recommended — a wedged
   * backend can otherwise consume worker slots indefinitely).
   */
  readonly spawnTimeoutMs?: number | undefined;
}

export interface WorkerRestartPolicy {
  readonly restart: RestartType;
  readonly maxRestarts: number;
  readonly maxRestartWindowMs: number;
  readonly backoffBaseMs: number;
  readonly backoffCeilingMs: number;
}

export const DEFAULT_WORKER_RESTART_POLICY: WorkerRestartPolicy = {
  restart: "transient",
  maxRestarts: 5,
  maxRestartWindowMs: 60_000,
  backoffBaseMs: 1000,
  backoffCeilingMs: 30_000,
};

export interface Supervisor {
  readonly start: (
    request: WorkerSpawnRequest,
    overrides?: {
      readonly restart?: WorkerRestartPolicy;
      readonly backend?: WorkerBackendKind;
    },
  ) => Promise<Result<WorkerHandle, KoiError>>;
  readonly stop: (id: WorkerId, reason: string) => Promise<Result<void, KoiError>>;
  readonly shutdown: (reason: string) => Promise<Result<void, KoiError>>;
  readonly list: () => readonly ProcessDescriptor[];
  readonly watchAll: () => AsyncIterable<WorkerEvent>;
}

// ---------------------------------------------------------------------------
// Session registry — cross-process session metadata
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a background session. The registry is the single
 * cross-process source of truth for these states; consumers (CLI `ps`,
 * observability dashboards, external orchestrators) read registry entries
 * rather than querying a live supervisor.
 *
 * - `starting`: `register()` has been called but no `started` event has been
 *   observed yet. Transient — visible only in race windows.
 * - `running`: `started` event observed; worker is live.
 * - `exited`: `exited` event observed (code=0 OR intentional termination).
 * - `crashed`: `crashed` event observed (code≠0 unsolicited, or backend fault).
 * - `detached`: operator-initiated detach; worker remains live but registry
 *   entry is retained for later `koi bg attach` reconnection. Used by tmux
 *   backend (3b-6); subprocess backend never emits this state.
 * - `terminating`: transient claim written by off-path killers (`koi bg
 *   kill`) BEFORE they signal the PID. Serves as a compare-and-swap
 *   receipt: if the claim update fails, the caller knows identity
 *   drifted since their last read and MUST NOT send a signal. A healthy
 *   kill transitions the record through `terminating → exited`. An
 *   orphaned `terminating` means the killer crashed between claim and
 *   signal — operators can resume by re-running `bg kill`.
 */
export type BackgroundSessionStatus =
  | "starting"
  | "running"
  | "exited"
  | "crashed"
  | "detached"
  | "terminating";

/**
 * Persisted per-session record. The registry stores one of these per worker.
 * Nullable lifecycle fields (`endedAt`, `exitCode`) are populated when the
 * worker terminates. All fields are serializable so the record round-trips
 * through JSON persistence unchanged.
 *
 * Named `BackgroundSession*` (not `Session*`) to disambiguate from
 * `@koi/core/session` — that module models chat sessions for crash recovery;
 * this module models OS-process lifecycle for the daemon.
 */
export interface BackgroundSessionRecord {
  readonly workerId: WorkerId;
  readonly agentId: AgentId;
  /** Optional logical session id (chat-session, job-id, etc.). */
  readonly sessionId?: string | undefined;
  /** OS process id. 0 for backends that lack a PID (in-process, some remote). */
  readonly pid: number;
  readonly status: BackgroundSessionStatus;
  readonly startedAt: number;
  readonly endedAt?: number | undefined;
  readonly exitCode?: number | undefined;
  /** Absolute path to the log file. Empty string if no log capture. */
  readonly logPath: string;
  readonly command: readonly string[];
  readonly backendKind: WorkerBackendKind;
  /**
   * Monotonic version bumped on every successful write. Enables optimistic
   * concurrency control: `update()` reads the record, applies the patch
   * against that specific version, and retries if a concurrent writer
   * advanced the version between read and rename. Treated as 0 when
   * absent (pre-CAS records or fresh registrations).
   */
  readonly version?: number | undefined;
}

/**
 * Partial update applied via `update(id, patch)`. `workerId`, `agentId`,
 * `command`, and `backendKind` are immutable post-register. `pid` and
 * `startedAt` MAY be updated — on worker restart the supervisor spawns a
 * fresh OS process under the same `workerId`, and the registry entry must
 * reflect the new process identity or `bg kill` will signal a dead/reused
 * PID. Callers that wire `attachRegistry` to a restartable supervisor are
 * responsible for patching `pid` + `startedAt` on every respawn (the
 * bridge only observes lifecycle events, not the spawn path, and so
 * cannot learn the new PID on its own).
 */
export interface BackgroundSessionUpdate {
  readonly status?: BackgroundSessionStatus;
  readonly endedAt?: number;
  readonly exitCode?: number;
  readonly sessionId?: string;
  readonly logPath?: string;
  readonly pid?: number;
  readonly startedAt?: number;
  /**
   * Optional compare-and-swap guard. When set, the registry rejects the
   * update with `CONFLICT` if the persisted record's `version` differs,
   * which protects callers that captured a specific record identity
   * (e.g. `bg kill` holding onto a pre-signal PID) from clobbering a
   * fresh session that the supervisor respawned under the same
   * `workerId` between the caller's read and its final write.
   *
   * Absent means "last-writer-wins" — the registry just bumps the
   * version to `(current ?? 0) + 1` as usual. Integrators wiring
   * `attachRegistry` do NOT need to set this; it's an escape hatch for
   * off-path writers.
   */
  readonly expectedVersion?: number;
  /**
   * Optional second CAS predicate: reject with `CONFLICT` if the
   * persisted `pid` differs. Paired with `expectedVersion` to defend
   * against the niche case where a restart happens to land on the same
   * version number (e.g. a crash-during-update left the version stuck).
   */
  readonly expectedPid?: number;
  /**
   * When true, the merge drops any previously-stored `endedAt` and
   * `exitCode` from the record. Required for correct `started`-event
   * handling: a transient/permanent restart produces a fresh `running`
   * status, and the prior exit's terminal metadata would otherwise
   * linger and mislead observers (e.g. showing `status=running` with
   * a stale `exitCode=137`).
   */
  readonly clearTerminal?: boolean;
}

/**
 * Discriminated union of registry change events. Emitted by `watch()`.
 * Consumers use these to react to session lifecycle without polling.
 */
export type BackgroundSessionEvent =
  | { readonly kind: "registered"; readonly record: BackgroundSessionRecord }
  | { readonly kind: "updated"; readonly record: BackgroundSessionRecord }
  | { readonly kind: "unregistered"; readonly workerId: WorkerId };

/**
 * Cross-process background-session registry. Backing store is
 * implementation-defined (file-backed JSON, SQLite, remote KV, etc.);
 * consumers should treat all operations as possibly-async and always `await`.
 *
 * Single-writer: multiple registry instances on the same backing directory
 * produce undefined behavior. Integrations should share one registry
 * instance per process.
 */
export interface BackgroundSessionRegistry {
  readonly register: (record: BackgroundSessionRecord) => Promise<Result<void, KoiError>>;
  readonly update: (
    id: WorkerId,
    patch: BackgroundSessionUpdate,
  ) => Promise<Result<BackgroundSessionRecord, KoiError>>;
  readonly unregister: (id: WorkerId) => Promise<Result<void, KoiError>>;
  readonly get: (id: WorkerId) => Promise<BackgroundSessionRecord | undefined>;
  readonly list: () => Promise<readonly BackgroundSessionRecord[]>;
  readonly watch: () => AsyncIterable<BackgroundSessionEvent>;
}

/**
 * Pure validator: checks that a candidate `BackgroundSessionRecord` is
 * well-formed. Used by registry implementations to reject malformed writes
 * early.
 *
 * Side-effect-free data validation, permitted in L0 per the architecture-doc
 * exceptions for pure helpers that operate only on L0 types.
 */
export function validateBackgroundSessionRecord(
  record: BackgroundSessionRecord,
): Result<BackgroundSessionRecord, KoiError> {
  if (record.workerId.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "BackgroundSessionRecord.workerId must be non-empty",
        retryable: false,
      },
    };
  }
  if (record.agentId.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "BackgroundSessionRecord.agentId must be non-empty",
        retryable: false,
      },
    };
  }
  if (!Number.isFinite(record.startedAt) || record.startedAt < 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "BackgroundSessionRecord.startedAt must be a non-negative finite number",
        retryable: false,
      },
    };
  }
  if (record.command.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "BackgroundSessionRecord.command must be non-empty",
        retryable: false,
      },
    };
  }
  if (!Number.isFinite(record.pid)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "BackgroundSessionRecord.pid must be a finite number",
        retryable: false,
      },
    };
  }
  return { ok: true, value: record };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateSupervisorConfig(
  config: SupervisorConfig,
): Result<SupervisorConfig, KoiError> {
  if (config.maxWorkers < 1) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "SupervisorConfig.maxWorkers must be >= 1",
        retryable: false,
      },
    };
  }
  if (Object.keys(config.backends).length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "SupervisorConfig.backends must register at least one backend. " +
          "Install @koi/daemon's subprocess backend or provide a custom WorkerBackend.",
        retryable: false,
      },
    };
  }
  if (config.shutdownDeadlineMs < 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "SupervisorConfig.shutdownDeadlineMs must be >= 0",
        retryable: false,
      },
    };
  }
  return { ok: true, value: config };
}
