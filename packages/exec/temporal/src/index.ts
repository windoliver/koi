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
export {
  AGENT_MESSAGE_SIGNAL,
  AGENT_SHUTDOWN_SIGNAL,
  AGENT_STATE_QUERY,
  AGENT_STATUS_QUERY,
  AGENT_WORKFLOW_NAME,
  RETRY_WORKFLOW_NAME,
  SCHEDULED_TASK_WORKFLOW_NAME,
  agentWorkflow,
  retryWorkflow,
  scheduledTaskWorkflow,
} from "./workflows/index.js";
export type {
  AgentStateRefs,
  AgentWorkflowConfig,
  IncomingMessage,
  RetryWorkflowArgs,
  RetryWorkflowResult,
  ScheduledInputPayload,
  ScheduledSpawnArgs,
  ScheduledTaskWorkflowArgs,
  ScheduledTaskWorkflowResult,
  TemporalConfig,
} from "./types.js";
export { DEFAULT_TEMPORAL_CONFIG } from "./types.js";

export {
  createWorkerBundle,
  createTemporalWorker,
  type NativeConnectionLike,
  type WorkerBundle,
  type WorkerAndConnection,
  type WorkerConfig,
  type WorkerCreateParams,
  type WorkerHandle,
  type WorkerLike,
} from "./worker-factory.js";
