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
  CapabilityConfig,
  ChannelConfig,
  ChannelIdentity,
  MiddlewareConfig,
  ModelConfig,
  PermissionConfig,
  SearchConfig,
  SkillConfig,
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
  BrickFitnessMetrics,
  BrickRequires,
  BrickUpdate,
  ForgeQuery,
  ForgeStore,
  ImplementationArtifact,
  LatencySampler,
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
export { DEFAULT_BRICK_FITNESS } from "./brick-store.js";
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
// capability — unforgeable capability tokens (L0 types + contracts)
export type {
  CapabilityDenyReason,
  CapabilityId,
  CapabilityScope,
  CapabilityToken,
  CapabilityVerifier,
  CapabilityVerifyResult,
  VerifierCache,
  VerifyContext,
} from "./capability.js";
// capability — runtime values (branded constructor + type guard)
export { capabilityId, isCapabilityToken } from "./capability.js";
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
// catalog — unified capability discovery across all sources
export type {
  CatalogEntry,
  CatalogPage,
  CatalogQuery,
  CatalogReader,
  CatalogSource,
  CatalogSourceError,
} from "./catalog.js";
export { ALL_CATALOG_SOURCES, DEFAULT_CATALOG_SEARCH_LIMIT } from "./catalog.js";
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
// cost tracker — per-session, per-tool, per-model cost transparency
export type {
  BudgetTracker,
  CostBreakdown,
  CostCalculator,
  CostEntry,
  ModelCostBreakdown,
  ToolCostBreakdown,
  UsageInfo,
} from "./cost-tracker.js";
// ecs — generic ComponentProvider factories (pure functions on L0 types)
export type { ServiceProviderConfig } from "./create-service-provider.js";
export { createServiceProvider } from "./create-service-provider.js";
export type { SingleToolProviderConfig } from "./create-single-tool-provider.js";
export { createSingleToolProvider } from "./create-single-tool-provider.js";
// delegation — types
export type {
  CapabilityProof,
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
// diagnostic provider — vendor-neutral code diagnostics contract
export type {
  DiagnosticItem,
  DiagnosticProvider,
  DiagnosticRange,
  DiagnosticSeverity,
} from "./diagnostic-provider.js";
// ecs — types
export type {
  Agent,
  AgentDescriptor,
  AgentId,
  AttachResult,
  ChildHandle,
  ChildLifecycleEvent,
  CompanionSkillDefinition,
  ComponentEvent,
  ComponentEventKind,
  ComponentProvider,
  CredentialComponent,
  EventComponent,
  MemoryComponent,
  MemoryRecallOptions,
  MemoryResult,
  MemoryStoreOptions,
  MemoryTier,
  ProcessAccounter,
  ProcessId,
  ProcessState,
  RegistryComponent,
  RunId,
  SessionId,
  SkillComponent,
  SkillMetadata,
  SkippedComponent,
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
  EXTERNAL_AGENTS,
  FILESYSTEM,
  GOVERNANCE,
  GOVERNANCE_BACKEND,
  HANDOFF,
  isAttachResult,
  MAILBOX,
  MEMORY,
  middlewareToken,
  NAME_SERVICE,
  REGISTRY,
  REPUTATION,
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
  ZONE_REGISTRY,
} from "./ecs.js";
// elicitation — structured user questioning contract
export type {
  ElicitationOption,
  ElicitationQuestion,
  ElicitationResult,
} from "./elicitation.js";
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
  TerminationOutcome,
} from "./engine.js";
export { mapStopReasonToOutcome } from "./engine.js";
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
// external agent — types for runtime discovery of external coding agents
export type {
  ExternalAgentDescriptor,
  ExternalAgentSource,
  ExternalAgentTransport,
} from "./external-agent.js";
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
// forge demand — demand-triggered forging signals and budget
export type { ForgeBudget, ForgeDemandSignal, ForgeTrigger } from "./forge-demand.js";
export { DEFAULT_FORGE_BUDGET } from "./forge-demand.js";
// forge types
export type {
  BrickKind,
  BrickLifecycle,
  DemotionCriteria,
  ForgeScope,
  TrustTransitionCaller,
} from "./forge-types.js";
export {
  ALL_BRICK_KINDS,
  DEFAULT_DEMOTION_CRITERIA,
  MIN_TRUST_BY_KIND,
  VALID_LIFECYCLE_TRANSITIONS,
} from "./forge-types.js";
// governance — types
export type {
  ContextPressureTrend,
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
// governance backend — pluggable rule-based policy evaluation contract
export type {
  ComplianceRecord,
  ComplianceRecorder,
  ConstraintChecker,
  ConstraintQuery,
  GovernanceBackend,
  GovernanceVerdict,
  PolicyEvaluator,
  PolicyRequest,
  PolicyRequestKind,
  Violation,
  ViolationFilter,
  ViolationPage,
  ViolationSeverity,
  ViolationStore,
} from "./governance-backend.js";
export {
  DEFAULT_VIOLATION_QUERY_LIMIT,
  GOVERNANCE_ALLOW,
  VIOLATION_SEVERITY_ORDER,
} from "./governance-backend.js";
// handoff — types
export type {
  ArtifactRef,
  DecisionRecord,
  HandoffAcceptError,
  HandoffAcceptResult,
  HandoffComponent,
  HandoffEnvelope,
  HandoffEvent,
  HandoffId,
  HandoffStatus,
} from "./handoff.js";
// handoff — runtime values
export { handoffId } from "./handoff.js";
// harness — multi-session long-horizon task harness types
export type {
  ContextSummary,
  HarnessId,
  HarnessMetrics,
  HarnessPhase,
  HarnessSnapshot,
  HarnessSnapshotStore,
  HarnessStatus,
  KeyArtifact,
} from "./harness.js";
export { harnessId } from "./harness.js";
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
// intent capsule — cryptographic mandate binding for ASI01 defense (L0 types + contract)
export type {
  CapsuleId,
  CapsulePayloadVersion,
  CapsuleVerifier,
  CapsuleVerifyResult,
  CapsuleViolationReason,
  IntentCapsule,
} from "./intent-capsule.js";
export { capsuleId, isIntentCapsule } from "./intent-capsule.js";
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
export { matchesFilter, VALID_TRANSITIONS } from "./lifecycle.js";
// mailbox — agent-to-agent messaging types
export type {
  AgentMessage,
  AgentMessageInput,
  MailboxComponent,
  MessageFilter,
  MessageId,
  MessageKind,
} from "./mailbox.js";
export { messageId } from "./mailbox.js";
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
  MiddlewareBundle,
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
// name service — DNS-like name resolution for agents and bricks
export type {
  AnsConfig,
  NameBinding,
  NameChangeEvent,
  NameChangeKind,
  NameQuery,
  NameRecord,
  NameRegistration,
  NameResolution,
  NameServiceBackend,
  NameServiceReader,
  NameServiceWriter,
  NameSuggestion,
} from "./name-service.js";
export { ANS_SCOPE_PRIORITY, DEFAULT_ANS_CONFIG } from "./name-service.js";
// permission backend — pluggable authorization contract
export type {
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
} from "./permission-backend.js";
// proposal — unified change governance contract
export type {
  ChangeKind,
  ChangeTarget,
  GateRequirement,
  Proposal,
  ProposalEvent,
  ProposalGate,
  ProposalId,
  ProposalInput,
  ProposalResult,
  ProposalStatus,
  ProposalUnsubscribe,
  ReviewDecision,
} from "./proposal.js";
export { ALL_CHANGE_TARGETS, PROPOSAL_GATE_REQUIREMENTS, proposalId } from "./proposal.js";
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
// reputation backend — pluggable trust scoring and feedback contract
export type {
  FeedbackKind,
  ReputationBackend,
  ReputationFeedback,
  ReputationLevel,
  ReputationQuery,
  ReputationQueryResult,
  ReputationScore,
} from "./reputation-backend.js";
export { DEFAULT_REPUTATION_QUERY_LIMIT, REPUTATION_LEVEL_ORDER } from "./reputation-backend.js";
// resolver
export type { Resolver, SourceBundle, SourceLanguage } from "./resolver.js";
// run report — structured summary of an autonomous agent run
export type {
  ActionEntry,
  IssueEntry,
  ReportStore,
  ReportSummary,
  RunCost,
  RunDuration,
  RunReport,
} from "./run-report.js";
// sandbox adapter — pluggable sandbox backends (OS-level, cloud, WASM)
export type {
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxExecOptions,
  SandboxInstance,
} from "./sandbox-adapter.js";
// sandbox executor — code execution in isolation (forge verification contract)
export type {
  ExecutionContext,
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
// scope enforcement — pluggable policy backend for subsystem access checks
export type {
  ScopeAccessRequest,
  ScopeEnforcer,
  ScopeSubsystem,
} from "./scope-enforcement.js";
// security analyzer — dynamic risk classification contract
export type {
  RiskAnalysis,
  RiskFinding,
  RiskLevel,
  SecurityAnalyzer,
} from "./security-analyzer.js";
export { RISK_ANALYSIS_UNKNOWN, RISK_LEVEL_ORDER } from "./security-analyzer.js";
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
// tool health — promoted L0 types for cross-package health data consumption
export type {
  ToolFailureRecord,
  ToolHealthMetrics,
  ToolHealthSnapshot,
  ToolHealthState,
} from "./tool-health-types.js";
// validation utilities — runtime type guards and validators
export { isProcessState, validateNonEmpty } from "./validation-utils.js";
// version index — version label → BrickId resolution contract
export type {
  VersionIndexBackend,
  VersionIndexReader,
  VersionIndexWriter,
} from "./version-index.js";
// version types — version labels + publisher identity
export type {
  PublisherId,
  ShadowWarning,
  VersionChangeEvent,
  VersionChangeKind,
  VersionEntry,
  VersionedBrickRef,
} from "./version-types.js";
export { publisherId } from "./version-types.js";
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
// zone — multi-zone agent coordination types
export type {
  ZoneDescriptor,
  ZoneEvent,
  ZoneFilter,
  ZoneId,
  ZoneRegistry,
  ZoneStatus,
} from "./zone.js";
// zone — runtime values (branded constructor)
export { zoneId } from "./zone.js";
