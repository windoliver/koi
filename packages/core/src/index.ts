/**
 * @koi/core — Interfaces-only kernel (Layer 0)
 *
 * Zero dependencies. Defines the 7 core contracts + ECS compositional layer.
 * Only runtime code: branded type constructors for SubsystemToken.
 */

// agent snapshot — per-agent state capture
export type { AgentSnapshot, AgentSnapshotStore } from "./agent-snapshot.js";
// assembly
export type {
  AgentManifest,
  ChannelConfig,
  MiddlewareConfig,
  ModelConfig,
  PermissionConfig,
  ToolConfig,
} from "./assembly.js";
// audit backend — structured audit logging contract
export type { AuditEntry, AuditSink, RedactionRule } from "./audit-backend.js";
// brick snapshot — version history, provenance, audit
export type {
  BrickId,
  BrickRef,
  BrickSnapshot,
  BrickSource,
  SnapshotEvent,
  SnapshotId,
  SnapshotQuery,
  SnapshotStore,
} from "./brick-snapshot.js";
export { brickId, snapshotId } from "./brick-snapshot.js";
// brick store — persistence contracts for forged artifacts
export type {
  AdvisoryLock,
  AgentArtifact,
  BrickArtifact,
  BrickArtifactBase,
  BrickRequires,
  BrickUpdate,
  CompositeArtifact,
  ForgeQuery,
  ForgeStore,
  LockHandle,
  LockMode,
  LockRequest,
  SkillArtifact,
  TestCase,
  ToolArtifact,
} from "./brick-store.js";
// channel
export type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelStatus,
  ChannelStatusKind,
  MessageHandler,
} from "./channel.js";
// common
export type { JsonObject } from "./common.js";
// config
export type {
  ConfigListener,
  ConfigSource,
  ConfigStore,
  ConfigUnsubscribe,
  FeatureFlags,
  ForgeConfigSection,
  KoiConfig,
  LimitsConfig,
  LogLevel,
  LoopDetectionConfigSection,
  ModelRouterConfigSection,
  ModelTargetConfigEntry,
  SpawnConfig,
  TelemetryConfig,
} from "./config.js";
// context
export type { CompactionResult, ContextCompactor, TokenEstimator } from "./context.js";
// correlation
export type { CorrelationIds } from "./correlation.js";
// delegation
export type {
  DelegationComponent,
  DelegationConfig,
  DelegationDenyReason,
  DelegationGrant,
  DelegationId,
  DelegationScope,
  DelegationVerifyResult,
  RevocationRegistry,
  ScopeChecker,
} from "./delegation.js";
// ecs — types
export type {
  Agent,
  AgentId,
  ChildHandle,
  ChildLifecycleEvent,
  ComponentProvider,
  CredentialComponent,
  EventComponent,
  GovernanceComponent,
  GovernanceUsage,
  MemoryComponent,
  MemoryResult,
  ProcessAccounter,
  ProcessId,
  ProcessState,
  RunId,
  SessionId,
  SkillMetadata,
  SpawnCheck,
  SpawnLedger,
  SubsystemToken,
  Tool,
  ToolCallId,
  ToolDescriptor,
  TrustTier,
  TurnId,
} from "./ecs.js";
// ecs — runtime values (token factories + well-known constants)
export {
  agentId,
  CREDENTIALS,
  channelToken,
  DELEGATION,
  EVENTS,
  FILESYSTEM,
  GOVERNANCE,
  MEMORY,
  runId,
  sessionId,
  skillToken,
  token,
  toolCallId,
  toolToken,
  turnId,
} from "./ecs.js";
// engine
export type {
  AbortReason,
  ComposedCallHandlers,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineInputBase,
  EngineMetrics,
  EngineOutput,
  EngineState,
  EngineStopReason,
} from "./engine.js";
// error factories — pure data constructors for KoiError objects
export {
  conflict,
  external,
  internal,
  notFound,
  permission,
  rateLimit,
  timeout,
  validation,
} from "./error-factories.js";
// errors — types
export type { BackendErrorMapper, KoiError, KoiErrorCode, Result } from "./errors.js";
// errors — runtime values
export { RETRYABLE_DEFAULTS } from "./errors.js";
// event backend
export type {
  DeadLetterEntry,
  DeadLetterFilter,
  EventBackend,
  EventBackendConfig,
  EventEnvelope,
  EventInput,
  ReadOptions,
  ReadResult,
  SubscribeOptions,
  SubscriptionHandle,
} from "./event-backend.js";
// eviction
export type {
  EvictionCandidate,
  EvictionPolicy,
  EvictionReason,
  EvictionResult,
} from "./eviction.js";
// filesystem backend
export type {
  FileEdit,
  FileEditOptions,
  FileEditResult,
  FileEntryKind,
  FileListEntry,
  FileListOptions,
  FileListResult,
  FileReadOptions,
  FileReadResult,
  FileSearchMatch,
  FileSearchOptions,
  FileSearchResult,
  FileSystemBackend,
  FileWriteOptions,
  FileWriteResult,
} from "./filesystem-backend.js";
// forge types
export type { BrickKind, BrickLifecycle, ForgeScope } from "./forge-types.js";
// health
export type {
  HealthMonitor,
  HealthMonitorConfig,
  HealthMonitorStats,
  HealthSnapshot,
  HealthStatus,
} from "./health.js";
// health — runtime values
export { DEFAULT_HEALTH_MONITOR_CONFIG } from "./health.js";
// lifecycle
export type {
  AgentCondition,
  AgentRegistry,
  AgentStatus,
  RegistryEntry,
  RegistryEvent,
  RegistryFilter,
  TransitionReason,
} from "./lifecycle.js";
// lifecycle — runtime values
export { VALID_TRANSITIONS } from "./lifecycle.js";
// message
export type {
  ButtonBlock,
  ContentBlock,
  CustomBlock,
  FileBlock,
  ImageBlock,
  InboundMessage,
  OutboundMessage,
  TextBlock,
} from "./message.js";
// middleware
export type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "./middleware.js";
// model provider
export type { ModelCapabilities, ModelProvider, ModelTarget } from "./model-provider.js";
// resolver
export type { Resolver, SourceBundle, SourceLanguage } from "./resolver.js";
// sandbox executor — code execution in isolation (forge verification contract)
export type {
  SandboxError,
  SandboxErrorCode,
  SandboxExecutor,
  SandboxResult,
  TieredSandboxExecutor,
  TierResolution,
} from "./sandbox-executor.js";
// sandbox profile — platform-agnostic isolation policy
export type {
  FilesystemPolicy,
  NetworkPolicy,
  ResourceLimits,
  SandboxProfile,
} from "./sandbox-profile.js";
// scheduler — types
export type {
  CronSchedule,
  ScheduledTask,
  ScheduleId,
  SchedulerConfig,
  SchedulerEvent,
  SchedulerStats,
  ScheduleStore,
  TaskFilter,
  TaskId,
  TaskOptions,
  TaskScheduler,
  TaskStatus,
  TaskStore,
} from "./scheduler.js";
// scheduler — runtime values (branded constructors + defaults)
export { DEFAULT_SCHEDULER_CONFIG, scheduleId, taskId } from "./scheduler.js";
// session — persistence contract for crash recovery
export type {
  PendingFrame,
  RecoveryPlan,
  SessionCheckpoint,
  SessionFilter,
  SessionPersistence,
  SessionRecord,
  SkippedRecoveryEntry,
} from "./session.js";
// snapshot chain — immutable DAG for time travel, fork, and recovery
export type {
  AncestorQuery,
  ChainCompactor,
  ChainId,
  ForkRef,
  NodeId,
  PruningPolicy,
  PutOptions,
  SnapshotChainStore,
  SnapshotNode,
} from "./snapshot-chain.js";
export { chainId, nodeId } from "./snapshot-chain.js";
// snapshot time-travel — filesystem journal, backtrack constraints, event trace
export type {
  BacktrackConstraint,
  BacktrackReason,
  BacktrackReasonKind,
  CompensatingOp,
  EventCursor,
  FileOpKind,
  FileOpRecord,
  TraceEvent,
  TraceEventKind,
  TurnTrace,
} from "./snapshot-time-travel.js";
export { BACKTRACK_REASON_KEY } from "./snapshot-time-travel.js";
// validation utilities — runtime type guards and validators
export { isProcessState, validateNonEmpty } from "./validation-utils.js";
