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
} from "./temporal-errors.js";
export {
  createTemporalHealthMonitor,
  DEFAULT_TEMPORAL_HEALTH_CONFIG,
  type TemporalHealthConfig,
  type TemporalHealthMonitor,
  type TemporalHealthSnapshot,
  type TemporalHealthStatus,
} from "./temporal-health.js";
export {
  createTemporalScheduler,
  type TemporalClientLike,
  type TemporalSchedulerConfig,
} from "./temporal-scheduler.js";
export {
  createTemporalSpawnLedger,
  DEFAULT_SPAWN_LEDGER_CONFIG,
  type SpawnLedgerSnapshot,
  type TemporalSpawnLedgerConfig,
} from "./temporal-spawn-ledger.js";
export type {
  AgentStateRefs,
  AgentWorkflowConfig,
  IncomingMessage,
  TemporalConfig,
} from "./types.js";
export { DEFAULT_TEMPORAL_CONFIG } from "./types.js";

export {
  createTemporalWorker,
  type NativeConnectionLike,
  type WorkerAndConnection,
  type WorkerCreateParams,
  type WorkerFactoryOptions,
  type WorkerHandle,
  type WorkerLike,
} from "./worker-factory.js";
