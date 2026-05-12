/**
 * @koi/proactive — proactive/autonomous tool surfaces.
 *
 * Phase 3a (issue #1195): sleep, cron, and monitor-facing tools layered over
 * the L0 SchedulerComponent. Channel/webhook surfaces ship in later phases.
 */

export {
  computeCompositionApproval,
  DEFAULT_COMPOSITION_APPROVAL_POLICY,
} from "./composition-approval.js";
export {
  type CheckpointEncoder,
  type CheckpointPhase,
  type CheckpointSnapshot,
  type CheckpointValue,
  type CompositionCheckpointStore,
  createInMemoryCheckpointStore,
  type InMemoryCheckpointStoreConfig,
  safeJsonEncoder,
} from "./composition-checkpoint-store.js";
export {
  type SqliteCheckpointStoreConfig,
  sqliteCompositionCheckpointStore,
} from "./composition-checkpoint-store-sqlite.js";
export {
  type SqliteDatabaseLike,
  type SqliteStatementLike,
  sqliteCompositionExecutionLog,
} from "./composition-execution-log-sqlite.js";
export {
  type CompositionExecutionContext,
  type CompositionExecutionLog,
  type CompositionExecutionStatus,
  type CompositionForgeRequest,
  type CompositionNotification,
  type CompositionPreCommitRejection,
  type CompositionSpawnRequest,
  type CompositionToolCallRequest,
  createCompositionExecutor,
  inMemoryCompositionExecutionLog,
  isPreCommitRejection,
  preCommitRejection,
} from "./composition-executor.js";
export {
  type CompositionGovernance,
  DEFAULT_COMPOSITION_GOVERNANCE,
  defaultPatternKey,
  evaluateCompositionGate,
  extractCapabilityGapsFromPlan,
  type GateDecision,
  inferCompositionGap,
  inferMissingCapabilities,
  inMemoryNoveltyTracker,
  inMemorySessionRateTracker,
  type NoveltyTracker,
  type OutcomeRecorder,
  type SessionRateTracker,
} from "./composition-governance.js";
export { mapSystemSignalToCompositionTrigger } from "./composition-trigger.js";
export { createProactiveTools } from "./create-proactive-tools.js";
export type { InboxEnvelope, InboxSink } from "./inbox-sink.js";
export {
  type CompositionPlannerAdapter,
  type CompositionPlannerAdapterInput,
  createLlmCompositionPlanner,
  type LlmCompositionPlannerConfig,
} from "./llm-composition-planner.js";
export {
  createCancelMonitorTool,
  createCreateMonitorTool,
  createListMonitorsTool,
  createMonitorToolState,
  createUpdateMonitorTool,
  formatMonitorWakeMessage,
  type MonitorRecord,
  type MonitorToolState,
} from "./monitor-tools.js";
export { createNotifyTool, type NotifyToolConfig } from "./notify-tool.js";
export {
  createProactiveDelivery,
  type DeliveryFailure,
  type DeliveryPreferences,
  type DeliveryPriority,
  type DeliveryResult,
  type ProactiveDelivery,
  type ProactiveDeliveryConfig,
  type ProactiveNotification,
} from "./proactive-delivery.js";
export { createProactiveToolsProvider } from "./provider.js";
export {
  createRuleBasedCompositionPlanner,
  type RuleBasedCompositionPlannerConfig,
} from "./rule-based-composition-planner.js";
export {
  createGovernanceSignalSource,
  type GovernanceSignalSourceConfig,
  type GovernanceThreshold,
} from "./system-signal-sources/governance.js";
export {
  createGroveSignalSource,
  type GroveEventSourceLike,
  type GroveSignalSourceConfig,
} from "./system-signal-sources/grove.js";
export {
  createNexusSignalSource,
  type NexusSignalSourceConfig,
  type NexusSubscribeFn,
} from "./system-signal-sources/nexus.js";
export type {
  ProactiveToolsConfig,
  ProactiveToolsProviderConfig,
  ResolveChannel,
} from "./types.js";
export { DEFAULT_MAX_SLEEP_MS, DEFAULT_WAKE_MESSAGE } from "./types.js";
