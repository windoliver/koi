/**
 * @koi/core — Interfaces-only kernel (Layer 0)
 *
 * Zero dependencies. Defines the 7 core contracts + ECS compositional layer.
 * Only runtime code: branded type constructors for SubsystemToken.
 */

// agent snapshot — per-agent state capture
export type { AgentSnapshot, AgentSnapshotStore } from "./agent-snapshot.js";
// agent state events — event-sourced registry domain events + fold function
export type {
  AgentDeregisteredEvent,
  AgentRegisteredEvent,
  AgentStateEvent,
  AgentStateEventKind,
  AgentTransitionedEvent,
} from "./agent-state-event.js";
export {
  evolveRegistryEntry,
  INITIAL_AGENT_STATUS,
  isAgentStateEvent,
} from "./agent-state-event.js";
// assembly
export type {
  AgentManifest,
  ChannelConfig,
  ChannelIdentity,
  MiddlewareConfig,
  ModelConfig,
  PermissionConfig,
  ToolConfig,
} from "./assembly.js";
// audit backend — structured audit logging contract
export type { AuditEntry, AuditSink, RedactionRule } from "./audit-backend.js";
// brick component map — per-kind ECS type mapping
export type { BrickComponentMap } from "./brick-component-map.js";
// brick registry — generic brick discovery and management
export type {
  BrickPage,
  BrickRegistryBackend,
  BrickRegistryChangeEvent,
  BrickRegistryChangeKind,
  BrickRegistryReader,
  BrickRegistryWriter,
  BrickSearchQuery,
} from "./brick-registry.js";
export { DEFAULT_BRICK_SEARCH_LIMIT } from "./brick-registry.js";
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
  ForgeQuery,
  ForgeStore,
  ImplementationArtifact,
  LockHandle,
  LockMode,
  LockRequest,
  SkillArtifact,
  StoreChangeEvent,
  StoreChangeKind,
  StoreChangeNotifier,
  TestCase,
  ToolArtifact,
} from "./brick-store.js";
// browser driver — cross-engine abstraction for browser automation
export type {
  BrowserActionOptions,
  BrowserConsoleEntry,
  BrowserConsoleLevel,
  BrowserConsoleOptions,
  BrowserConsoleResult,
  BrowserDriver,
  BrowserEvaluateOptions,
  BrowserEvaluateResult,
  BrowserFormField,
  BrowserNavigateOptions,
  BrowserNavigateResult,
  BrowserRefInfo,
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserScrollOptions,
  BrowserSnapshotOptions,
  BrowserSnapshotResult,
  BrowserTabCloseOptions,
  BrowserTabFocusOptions,
  BrowserTabInfo,
  BrowserTabNewOptions,
  BrowserTraceOptions,
  BrowserTraceResult,
  BrowserTypeOptions,
  BrowserUploadFile,
  BrowserUploadOptions,
  BrowserWaitOptions,
  BrowserWaitUntil,
} from "./browser-driver.js";
// bundle types — portable agent export/import envelope
export type { AgentBundle, BundleId } from "./bundle-types.js";
export { BUNDLE_FORMAT_VERSION, bundleId } from "./bundle-types.js";
// capability registry — shared wire types for node capability advertisement
export type {
  AdvertisedTool,
  CapabilityRegistry,
  CapacityReport,
  NodeCapability,
  ToolCallPayload,
  ToolErrorPayload,
  ToolResultPayload,
} from "./capability-registry.js";
export { isToolCallPayload } from "./capability-registry.js";
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
// delegation — types
export type {
  CircuitBreakerConfig,
  DelegationComponent,
  DelegationConfig,
  DelegationDenyReason,
  DelegationEvent,
  DelegationGrant,
  DelegationId,
  DelegationManagerConfig,
  DelegationScope,
  DelegationVerifyResult,
  RevocationRegistry,
  ScopeChecker,
} from "./delegation.js";
// delegation — runtime values
export { DEFAULT_CIRCUIT_BREAKER_CONFIG, delegationId } from "./delegation.js";
// ecs — types
export type {
  Agent,
  AgentDescriptor,
  AgentId,
  ChildHandle,
  ChildLifecycleEvent,
  ComponentEvent,
  ComponentEventKind,
  ComponentProvider,
  CredentialComponent,
  EventComponent,
  MemoryComponent,
  MemoryResult,
  ProcessAccounter,
  ProcessId,
  ProcessState,
  RunId,
  SessionId,
  SkillComponent,
  SkillMetadata,
  SpawnLedger,
  SubsystemToken,
  Tool,
  ToolCallId,
  ToolDescriptor,
  ToolExecuteOptions,
  TrustTier,
  TurnId,
  WorkspaceComponent,
} from "./ecs.js";
// ecs — runtime values (token factories + well-known constants)
export {
  agentId,
  agentToken,
  BROWSER,
  COMPONENT_PRIORITY,
  CREDENTIALS,
  channelToken,
  DELEGATION,
  EVENTS,
  FILESYSTEM,
  GOVERNANCE,
  MEMORY,
  middlewareToken,
  runId,
  SCHEDULER,
  sessionId,
  skillToken,
  token,
  toolCallId,
  toolToken,
  turnId,
  WEBHOOK,
  WORKSPACE,
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
  staleRef,
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
  FileDeleteResult,
  FileEdit,
  FileEditOptions,
  FileEditResult,
  FileEntryKind,
  FileListEntry,
  FileListOptions,
  FileListResult,
  FileReadOptions,
  FileReadResult,
  FileRenameResult,
  FileSearchMatch,
  FileSearchOptions,
  FileSearchResult,
  FileSystemBackend,
  FileWriteOptions,
  FileWriteResult,
} from "./filesystem-backend.js";
// forge types
export type { BrickKind, BrickLifecycle, ForgeScope } from "./forge-types.js";
export { ALL_BRICK_KINDS, MIN_TRUST_BY_KIND, VALID_LIFECYCLE_TRANSITIONS } from "./forge-types.js";
// governance — types
export type {
  GovernanceCheck,
  GovernanceController,
  GovernanceEvent,
  GovernanceSnapshot,
  GovernanceVariable,
  GovernanceVariableContributor,
  SensorReading,
} from "./governance.js";
// governance — runtime values
export { GOVERNANCE_VARIABLES, governanceContributorToken } from "./governance.js";
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
// kernel extension — pluggable L1 guard/lifecycle/assembly slots
export type {
  GuardContext,
  KernelExtension,
  TransitionContext,
  ValidationDiagnostic,
  ValidationResult,
} from "./kernel-extension.js";
export { EXTENSION_PRIORITY } from "./kernel-extension.js";
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
  CapabilityFragment,
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
// provenance — SLSA-inspired attestation metadata
export type {
  ContentMarker,
  DataClassification,
  ForgeAttestationSignature,
  ForgeBuildDefinition,
  ForgeBuilder,
  ForgeProvenance,
  ForgeResourceRef,
  ForgeRunMetadata,
  ForgeStageDigest,
  ForgeVerificationSummary,
  InTotoStatementV1,
  InTotoSubject,
  SigningBackend,
} from "./provenance.js";
// reconciliation — desired-state convergence contract
export type {
  ReconcileContext,
  ReconcileResult,
  ReconcileRunnerConfig,
  ReconciliationController,
} from "./reconciliation.js";
export { DEFAULT_RECONCILE_RUNNER_CONFIG } from "./reconciliation.js";
// resolver
export type { Resolver, SourceBundle, SourceLanguage } from "./resolver.js";
// sandbox adapter — pluggable sandbox backends (OS-level, cloud, WASM)
export type {
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxExecOptions,
  SandboxInstance,
} from "./sandbox-adapter.js";
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
  SchedulerComponent,
  SchedulerConfig,
  SchedulerEvent,
  SchedulerStats,
  ScheduleStore,
  TaskFilter,
  TaskHistoryFilter,
  TaskId,
  TaskOptions,
  TaskRunRecord,
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
// skill registry — types
export type {
  SkillId,
  SkillPage,
  SkillPublishRequest,
  SkillRegistryBackend,
  SkillRegistryChangeEvent,
  SkillRegistryChangeKind,
  SkillRegistryEntry,
  SkillRegistryReader,
  SkillRegistryWriter,
  SkillSearchQuery,
  SkillVersion,
} from "./skill-registry.js";
// skill registry — runtime values
export { DEFAULT_SKILL_SEARCH_LIMIT, skillId } from "./skill-registry.js";
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
// supervision — Erlang/OTP-style hierarchical fault recovery
export type {
  ChildSpec,
  RestartType,
  SupervisionConfig,
  SupervisionStrategy,
} from "./supervision.js";
export { DEFAULT_SUPERVISION_CONFIG } from "./supervision.js";
// task-board — types
export type {
  TaskBoard,
  TaskBoardConfig,
  TaskBoardEvent,
  TaskBoardSnapshot,
  TaskItem,
  TaskItemId,
  TaskItemInput,
  TaskItemPatch,
  TaskItemStatus,
  TaskResult,
} from "./task-board.js";
// task-board — runtime values (branded constructor + defaults)
export { DEFAULT_TASK_BOARD_CONFIG, taskItemId } from "./task-board.js";
// validation utilities — runtime type guards and validators
export { isProcessState, validateNonEmpty } from "./validation-utils.js";
// webhook — outbound webhook delivery contract
export type {
  OutboundWebhookConfig,
  WebhookComponent,
  WebhookDeliveryStatus,
  WebhookEndpointHealth,
  WebhookEventKind,
  WebhookPayload,
  WebhookSummary,
} from "./webhook.js";
