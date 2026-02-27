import { describe, expect, test } from "bun:test";

/**
 * Export inventory — compile-time regression guard.
 * If any export is removed, this file will fail to compile.
 */

import type {
  // capability registry
  AdvertisedTool,
  Agent,
  // lifecycle
  AgentCondition,
  AgentDescriptor,
  AgentId,
  AgentManifest,
  AgentRegistry,
  AgentStatus,
  BrickComponentMap,
  ButtonBlock,
  CapabilityRegistry,
  CapacityReport,
  ChannelAdapter,
  // channel
  ChannelCapabilities,
  ChannelConfig,
  ChildHandle,
  ChildLifecycleEvent,
  ComponentProvider,
  ContentBlock,
  CredentialComponent,
  CustomBlock,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineMetrics,
  EngineOutput,
  EngineState,
  EngineStopReason,
  EventComponent,
  // eviction
  EvictionCandidate,
  EvictionPolicy,
  EvictionReason,
  EvictionResult,
  // reputation backend
  FeedbackKind,
  FileBlock,
  GovernanceCheck,
  GovernanceController,
  // health
  HealthMonitor,
  HealthMonitorConfig,
  HealthMonitorStats,
  HealthSnapshot,
  HealthStatus,
  ImageBlock,
  ImplementationArtifact,
  InboundMessage,
  // common
  JsonObject,
  KoiError,
  // errors
  KoiErrorCode,
  KoiMiddleware,
  MemoryComponent,
  MemoryRecallOptions,
  MemoryResult,
  MemoryStoreOptions,
  MemoryTier,
  MessageHandler,
  MiddlewareConfig,
  // assembly
  ModelConfig,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  NodeCapability,
  OutboundMessage,
  PermissionConfig,
  ProcessAccounter,
  ProcessId,
  ProcessState,
  RegistryEntry,
  RegistryEvent,
  RegistryFilter,
  ReputationBackend,
  ReputationFeedback,
  ReputationLevel,
  ReputationQuery,
  ReputationQueryResult,
  ReputationScore,
  // resolver
  Resolver,
  Result,
  SchedulerComponent,
  // delegation
  ScopeChecker,
  // middleware
  SessionContext,
  SkillComponent,
  SkillMetadata,
  SourceBundle,
  SourceLanguage,
  // ecs
  SubsystemToken,
  TaskHistoryFilter,
  TaskRunRecord,
  // message
  TextBlock,
  Tool,
  ToolCallPayload,
  ToolConfig,
  ToolDescriptor,
  ToolErrorPayload,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  ToolResultPayload,
  TransitionReason,
  TrustTier,
  TurnContext,
  WebhookComponent,
  WebhookEndpointHealth,
  WebhookSummary,
} from "../index.js";
import {
  ALL_BRICK_KINDS,
  agentId,
  agentToken,
  COMPONENT_PRIORITY,
  CREDENTIALS,
  channelToken,
  DEFAULT_HEALTH_MONITOR_CONFIG,
  DEFAULT_REPUTATION_QUERY_LIMIT,
  EVENTS,
  GOVERNANCE,
  GOVERNANCE_VARIABLES,
  governanceContributorToken,
  isToolCallPayload,
  MEMORY,
  MIN_TRUST_BY_KIND,
  middlewareToken,
  REPUTATION_LEVEL_ORDER,
  RETRYABLE_DEFAULTS,
  SCHEDULER,
  skillToken,
  token,
  toolToken,
  VALID_TRANSITIONS,
  WEBHOOK,
} from "../index.js";

// Prevent type imports from being optimized away
type AssertDefined<T> = T extends undefined ? never : T;
type _TypeGuard =
  | AssertDefined<JsonObject>
  | AssertDefined<TrustTier>
  | AssertDefined<KoiErrorCode>
  | AssertDefined<KoiError>
  | AssertDefined<Result<unknown>>
  | AssertDefined<TextBlock>
  | AssertDefined<FileBlock>
  | AssertDefined<ImageBlock>
  | AssertDefined<ButtonBlock>
  | AssertDefined<CustomBlock>
  | AssertDefined<ContentBlock>
  | AssertDefined<OutboundMessage>
  | AssertDefined<InboundMessage>
  | AssertDefined<SessionContext>
  | AssertDefined<TurnContext>
  | AssertDefined<ModelRequest>
  | AssertDefined<ModelResponse>
  | AssertDefined<ModelHandler>
  | AssertDefined<ToolRequest>
  | AssertDefined<ToolResponse>
  | AssertDefined<ToolHandler>
  | AssertDefined<KoiMiddleware>
  | AssertDefined<ChannelCapabilities>
  | AssertDefined<MessageHandler>
  | AssertDefined<ChannelAdapter>
  | AssertDefined<Resolver<unknown, unknown>>
  | AssertDefined<ModelConfig>
  | AssertDefined<ToolConfig>
  | AssertDefined<ChannelConfig>
  | AssertDefined<MiddlewareConfig>
  | AssertDefined<PermissionConfig>
  | AssertDefined<AgentManifest>
  | AssertDefined<EngineStopReason>
  | AssertDefined<EngineMetrics>
  | AssertDefined<EngineOutput>
  | AssertDefined<EngineState>
  | AssertDefined<EngineInput>
  | AssertDefined<EngineEvent>
  | AssertDefined<EngineAdapter>
  | AssertDefined<SubsystemToken<unknown>>
  | AssertDefined<ProcessState>
  | AssertDefined<ProcessId>
  | AssertDefined<Agent>
  | AssertDefined<ToolDescriptor>
  | AssertDefined<Tool>
  | AssertDefined<TrustTier>
  | AssertDefined<SkillMetadata>
  | AssertDefined<ComponentProvider>
  | AssertDefined<MemoryComponent>
  | AssertDefined<MemoryRecallOptions>
  | AssertDefined<MemoryResult>
  | AssertDefined<MemoryStoreOptions>
  | AssertDefined<MemoryTier>
  | AssertDefined<GovernanceController>
  | AssertDefined<GovernanceCheck>
  | AssertDefined<CredentialComponent>
  | AssertDefined<EventComponent>
  | AssertDefined<ProcessAccounter>
  | AssertDefined<ChildHandle>
  | AssertDefined<ChildLifecycleEvent>
  | AssertDefined<ScopeChecker>
  // lifecycle
  | AssertDefined<AgentId>
  | AssertDefined<AgentCondition>
  | AssertDefined<AgentStatus>
  | AssertDefined<AgentRegistry>
  | AssertDefined<TransitionReason>
  | AssertDefined<RegistryEntry>
  | AssertDefined<RegistryEvent>
  | AssertDefined<RegistryFilter>
  // health
  | AssertDefined<HealthStatus>
  | AssertDefined<HealthSnapshot>
  | AssertDefined<HealthMonitorStats>
  | AssertDefined<HealthMonitorConfig>
  | AssertDefined<HealthMonitor>
  // eviction
  | AssertDefined<EvictionCandidate>
  | AssertDefined<EvictionReason>
  | AssertDefined<EvictionResult>
  | AssertDefined<EvictionPolicy>
  // resolver source types
  | AssertDefined<SourceBundle>
  | AssertDefined<SourceLanguage>
  | AssertDefined<ImplementationArtifact>
  // brick component map
  | AssertDefined<BrickComponentMap>
  // ecs extensions
  | AssertDefined<SkillComponent>
  | AssertDefined<AgentDescriptor>
  // capability registry
  | AssertDefined<AdvertisedTool>
  | AssertDefined<CapacityReport>
  | AssertDefined<ToolCallPayload>
  | AssertDefined<ToolResultPayload>
  | AssertDefined<ToolErrorPayload>
  | AssertDefined<NodeCapability>
  | AssertDefined<CapabilityRegistry>
  // scheduler component
  | AssertDefined<SchedulerComponent>
  | AssertDefined<TaskRunRecord>
  | AssertDefined<TaskHistoryFilter>
  // webhook component
  | AssertDefined<WebhookComponent>
  | AssertDefined<WebhookEndpointHealth>
  | AssertDefined<WebhookSummary>
  // reputation backend
  | AssertDefined<FeedbackKind>
  | AssertDefined<ReputationBackend>
  | AssertDefined<ReputationFeedback>
  | AssertDefined<ReputationLevel>
  | AssertDefined<ReputationQuery>
  | AssertDefined<ReputationQueryResult>
  | AssertDefined<ReputationScore>;

describe("export inventory", () => {
  test("all runtime values are defined", () => {
    expect(token).toBeDefined();
    expect(toolToken).toBeDefined();
    expect(channelToken).toBeDefined();
    expect(skillToken).toBeDefined();
    expect(middlewareToken).toBeDefined();
    expect(agentToken).toBeDefined();
    expect(agentId).toBeDefined();
    expect(MEMORY).toBeDefined();
    expect(GOVERNANCE).toBeDefined();
    expect(GOVERNANCE_VARIABLES).toBeDefined();
    expect(governanceContributorToken).toBeDefined();
    expect(CREDENTIALS).toBeDefined();
    expect(EVENTS).toBeDefined();
    expect(RETRYABLE_DEFAULTS).toBeDefined();
    expect(VALID_TRANSITIONS).toBeDefined();
    expect(DEFAULT_HEALTH_MONITOR_CONFIG).toBeDefined();
    expect(ALL_BRICK_KINDS).toBeDefined();
    expect(MIN_TRUST_BY_KIND).toBeDefined();
    expect(COMPONENT_PRIORITY).toBeDefined();
    expect(isToolCallPayload).toBeDefined();
    expect(SCHEDULER).toBeDefined();
    expect(WEBHOOK).toBeDefined();
    expect(DEFAULT_REPUTATION_QUERY_LIMIT).toBeDefined();
    expect(REPUTATION_LEVEL_ORDER).toBeDefined();
  });

  test("runtime values are functions, strings, or objects", () => {
    expect(typeof token).toBe("function");
    expect(typeof toolToken).toBe("function");
    expect(typeof channelToken).toBe("function");
    expect(typeof skillToken).toBe("function");
    expect(typeof middlewareToken).toBe("function");
    expect(typeof agentToken).toBe("function");
    expect(typeof agentId).toBe("function");
    expect(typeof MEMORY).toBe("string");
    expect(typeof GOVERNANCE).toBe("string");
    expect(typeof CREDENTIALS).toBe("string");
    expect(typeof EVENTS).toBe("string");
    expect(typeof RETRYABLE_DEFAULTS).toBe("object");
    expect(typeof VALID_TRANSITIONS).toBe("object");
    expect(typeof DEFAULT_HEALTH_MONITOR_CONFIG).toBe("object");
    expect(typeof COMPONENT_PRIORITY).toBe("object");
    expect(typeof isToolCallPayload).toBe("function");
    expect(typeof SCHEDULER).toBe("string");
    expect(typeof WEBHOOK).toBe("string");
    expect(typeof DEFAULT_REPUTATION_QUERY_LIMIT).toBe("number");
    expect(typeof REPUTATION_LEVEL_ORDER).toBe("object");
  });
});
