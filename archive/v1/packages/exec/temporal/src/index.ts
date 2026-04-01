/**
 * @koi/temporal — Optional durable agent execution via Temporal.
 *
 * L3 package: imports from L0 (@koi/core) only. All other deps are structural.
 * All Temporal SDK types are internal — the public API exposes only L0 types.
 *
 * ## Anti-leak guarantee
 *
 * No @temporalio/* types appear in any public export. The public API uses:
 * - L0 contracts: SpawnLedger, TaskScheduler
 * - Internal types: TemporalConfig, TemporalHealthSnapshot
 * - Structural types: WorkerLike, NativeConnectionLike
 */

// -- Types (public) ----------------------------------------------------------

export type {
  AgentStateRefs,
  AgentTurnInput,
  AgentTurnResult,
  AgentWorkflowConfig,
  EngineCacheKey,
  IncomingMessage,
  SpawnChildRequest,
  TemporalConfig,
  WorkerWorkflowConfig,
} from "./types.js";

export { DEFAULT_TEMPORAL_CONFIG } from "./types.js";

// -- Error mapping -----------------------------------------------------------

export {
  type ApplicationFailurePayload,
  mapKoiErrorToApplicationFailure,
  mapTemporalError,
} from "./temporal-errors.js";

// -- Health monitor ----------------------------------------------------------

export {
  createTemporalHealthMonitor,
  DEFAULT_TEMPORAL_HEALTH_CONFIG,
  type TemporalHealthConfig,
  type TemporalHealthMonitor,
  type TemporalHealthSnapshot,
  type TemporalHealthStatus,
} from "./temporal-health.js";

// -- Engine cache ------------------------------------------------------------

export {
  type CachedRuntime,
  createEngineCache,
  type EngineCache,
  type RuntimeFactory,
} from "./engine-cache.js";

// -- Temporal embed mode -----------------------------------------------------

export {
  DEFAULT_EMBED_CONFIG,
  ensureTemporalRunning,
  type TemporalEmbedConfig,
  type TemporalEmbedHandle,
} from "./temporal-embed.js";

// -- SpawnLedger (L0 contract implementation) --------------------------------

export {
  createTemporalSpawnLedger,
  DEFAULT_SPAWN_LEDGER_CONFIG,
  type SpawnLedgerSnapshot,
  type TemporalSpawnLedgerConfig,
} from "./temporal-spawn-ledger.js";

// -- TaskScheduler (L0 contract implementation) ------------------------------

export {
  createTemporalScheduler,
  type TemporalClientLike,
  type TemporalSchedulerConfig,
} from "./temporal-scheduler.js";

// -- Worker factory ----------------------------------------------------------

export {
  createTemporalWorker,
  type NativeConnectionLike,
  type WorkerAndConnection,
  type WorkerCreateParams,
  type WorkerFactoryOptions,
  type WorkerHandle,
  type WorkerLike,
} from "./worker-factory.js";

// -- Activity factory --------------------------------------------------------

export {
  type ActivityDeps,
  createActivities,
  type GatewayStreamFrame,
} from "./activities/agent-activity.js";

// -- Signal/query names (shared between workflow sandbox and client) ----------

export {
  type AgentActivityStatus,
  MESSAGE_SIGNAL_NAME,
  type MessageSignalPayload,
  PENDING_COUNT_QUERY_NAME,
  type PendingCountQueryResult,
  SHUTDOWN_SIGNAL_NAME,
  type ShutdownSignalPayload,
  STATE_QUERY_NAME,
  STATUS_QUERY_NAME,
  type StateQueryResult,
  type StatusQueryResult,
} from "./workflows/signals.js";
