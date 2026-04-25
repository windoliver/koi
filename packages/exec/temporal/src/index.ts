/**
 * @koi/temporal — Optional durable agent execution via Temporal.
 *
 * L2 package: imports from @koi/core (L0) only. All Temporal SDK types are internal.
 *
 * Anti-leak guarantee: no @temporalio/* types appear in any public export.
 * The public API exposes only L0 contracts (SpawnLedger, TaskScheduler) and
 * structural types (WorkerLike, NativeConnectionLike, TemporalConfig).
 */

export {
  type ApplicationFailurePayload,
  mapKoiErrorToApplicationFailure,
  mapTemporalError,
} from "./errors.js";

export {
  createTemporalScheduler,
  type TemporalClientLike,
  type TemporalSchedulerConfig,
} from "./scheduler.js";
export {
  createTemporalSpawnLedger,
  DEFAULT_SPAWN_LEDGER_CONFIG,
  type SpawnLedgerSnapshot,
  type TemporalSpawnLedgerConfig,
} from "./spawn-ledger.js";
export {
  createTemporalWorker,
  type NativeConnectionLike,
  type TemporalConfig,
  type WorkerAndConnection,
  type WorkerCreateParams,
  type WorkerHandle,
  type WorkerLike,
} from "./worker-factory.js";
