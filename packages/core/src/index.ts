/**
 * @koi/core — Interfaces-only kernel (Layer 0)
 *
 * Zero dependencies. Defines the 6 core contracts + ECS compositional layer.
 * Only runtime code: branded type constructors for SubsystemToken.
 */

// assembly
export type {
  AgentManifest,
  ChannelConfig,
  MiddlewareConfig,
  ModelConfig,
  PermissionConfig,
  ToolConfig,
} from "./assembly.js";
// channel
export type { ChannelAdapter, ChannelCapabilities, MessageHandler } from "./channel.js";
// common
export type { JsonObject } from "./common.js";
// context
export type { CompactionResult, ContextCompactor, TokenEstimator } from "./context.js";
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
  SkillMetadata,
  SpawnCheck,
  SpawnLedger,
  SubsystemToken,
  Tool,
  ToolDescriptor,
  TrustTier,
} from "./ecs.js";
// ecs — runtime values (token factories + well-known constants)
export {
  agentId,
  CREDENTIALS,
  channelToken,
  DELEGATION,
  EVENTS,
  GOVERNANCE,
  MEMORY,
  skillToken,
  token,
  toolToken,
} from "./ecs.js";
// engine
export type {
  ComposedCallHandlers,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineMetrics,
  EngineOutput,
  EngineState,
  EngineStopReason,
} from "./engine.js";
// errors — types
export type { KoiError, KoiErrorCode, Result } from "./errors.js";
// errors — runtime values
export { RETRYABLE_DEFAULTS } from "./errors.js";
// eviction
export type {
  EvictionCandidate,
  EvictionPolicy,
  EvictionReason,
  EvictionResult,
} from "./eviction.js";
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
export type { Resolver } from "./resolver.js";
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
