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
  | { readonly kind: "started"; readonly workerId: WorkerId; readonly at: number }
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
