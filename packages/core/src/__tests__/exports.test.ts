import { describe, expect, test } from "bun:test";

/**
 * Export inventory — compile-time regression guard.
 * If any export is removed, this file will fail to compile.
 */

import type {
  Agent,
  // lifecycle
  AgentCondition,
  AgentId,
  AgentManifest,
  AgentRegistry,
  AgentStatus,
  ButtonBlock,
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
  FileBlock,
  GovernanceComponent,
  GovernanceUsage,
  // health
  HealthMonitor,
  HealthMonitorConfig,
  HealthMonitorStats,
  HealthSnapshot,
  HealthStatus,
  ImageBlock,
  InboundMessage,
  // common
  JsonObject,
  KoiError,
  // errors
  KoiErrorCode,
  KoiMiddleware,
  MemoryComponent,
  MemoryResult,
  MessageHandler,
  MiddlewareConfig,
  // assembly
  ModelConfig,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  OutboundMessage,
  PermissionConfig,
  ProcessAccounter,
  ProcessId,
  ProcessState,
  RegistryEntry,
  RegistryEvent,
  RegistryFilter,
  // resolver
  Resolver,
  Result,
  // delegation
  ScopeChecker,
  // middleware
  SessionContext,
  SkillMetadata,
  SourceBundle,
  SourceLanguage,
  SpawnCheck,
  // ecs
  SubsystemToken,
  // message
  TextBlock,
  Tool,
  ToolConfig,
  ToolDescriptor,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TransitionReason,
  TrustTier,
  TurnContext,
} from "../index.js";

import {
  agentId,
  CREDENTIALS,
  channelToken,
  DEFAULT_HEALTH_MONITOR_CONFIG,
  EVENTS,
  GOVERNANCE,
  MEMORY,
  RETRYABLE_DEFAULTS,
  skillToken,
  token,
  toolToken,
  VALID_TRANSITIONS,
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
  | AssertDefined<MemoryResult>
  | AssertDefined<GovernanceComponent>
  | AssertDefined<GovernanceUsage>
  | AssertDefined<SpawnCheck>
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
  | AssertDefined<SourceLanguage>;

describe("export inventory", () => {
  test("all runtime values are defined", () => {
    expect(token).toBeDefined();
    expect(toolToken).toBeDefined();
    expect(channelToken).toBeDefined();
    expect(skillToken).toBeDefined();
    expect(agentId).toBeDefined();
    expect(MEMORY).toBeDefined();
    expect(GOVERNANCE).toBeDefined();
    expect(CREDENTIALS).toBeDefined();
    expect(EVENTS).toBeDefined();
    expect(RETRYABLE_DEFAULTS).toBeDefined();
    expect(VALID_TRANSITIONS).toBeDefined();
    expect(DEFAULT_HEALTH_MONITOR_CONFIG).toBeDefined();
  });

  test("runtime values are functions, strings, or objects", () => {
    expect(typeof token).toBe("function");
    expect(typeof toolToken).toBe("function");
    expect(typeof channelToken).toBe("function");
    expect(typeof skillToken).toBe("function");
    expect(typeof agentId).toBe("function");
    expect(typeof MEMORY).toBe("string");
    expect(typeof GOVERNANCE).toBe("string");
    expect(typeof CREDENTIALS).toBe("string");
    expect(typeof EVENTS).toBe("string");
    expect(typeof RETRYABLE_DEFAULTS).toBe("object");
    expect(typeof VALID_TRANSITIONS).toBe("object");
    expect(typeof DEFAULT_HEALTH_MONITOR_CONFIG).toBe("object");
  });
});
