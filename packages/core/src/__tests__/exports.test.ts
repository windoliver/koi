import { describe, expect, test } from "bun:test";

/**
 * Export inventory — compile-time regression guard.
 * If any export is removed, this file will fail to compile.
 */

import type {
  Agent,
  AgentManifest,
  ButtonBlock,
  ChannelAdapter,
  // channel
  ChannelCapabilities,
  ChannelConfig,
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
  // engine
  EngineStopReason,
  EventComponent,
  FileBlock,
  // sandbox
  FilesystemPolicy,
  GovernanceComponent,
  ImageBlock,
  InboundMessage,
  KoiError,
  // errors
  KoiErrorCode,
  KoiMiddleware,
  MemoryComponent,
  MessageHandler,
  MiddlewareConfig,
  // assembly
  ModelConfig,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  NetworkPolicy,
  OutboundMessage,
  PermissionConfig,
  ProcessId,
  ProcessState,
  // resolver
  Resolver,
  ResourceLimits,
  Result,
  SandboxAdapter,
  SandboxExecOptions,
  SandboxInstance,
  SandboxProfile,
  SandboxResult,
  SandboxTier,
  // middleware
  SessionContext,
  SkillMetadata,
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
  TurnContext,
} from "../index.js";

import {
  CREDENTIALS,
  channelToken,
  EVENTS,
  GOVERNANCE,
  MEMORY,
  skillToken,
  token,
  toolToken,
} from "../index.js";

// Prevent type imports from being optimized away
type AssertDefined<T> = T extends undefined ? never : T;
type _TypeGuard =
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
  | AssertDefined<SkillMetadata>
  | AssertDefined<ComponentProvider>
  | AssertDefined<MemoryComponent>
  | AssertDefined<GovernanceComponent>
  | AssertDefined<CredentialComponent>
  | AssertDefined<EventComponent>
  | AssertDefined<SandboxTier>
  | AssertDefined<FilesystemPolicy>
  | AssertDefined<NetworkPolicy>
  | AssertDefined<ResourceLimits>
  | AssertDefined<SandboxAdapter>
  | AssertDefined<SandboxExecOptions>
  | AssertDefined<SandboxInstance>
  | AssertDefined<SandboxProfile>
  | AssertDefined<SandboxResult>;

describe("export inventory", () => {
  test("all runtime values are defined", () => {
    expect(token).toBeDefined();
    expect(toolToken).toBeDefined();
    expect(channelToken).toBeDefined();
    expect(skillToken).toBeDefined();
    expect(MEMORY).toBeDefined();
    expect(GOVERNANCE).toBeDefined();
    expect(CREDENTIALS).toBeDefined();
    expect(EVENTS).toBeDefined();
  });

  test("runtime values are functions or strings", () => {
    expect(typeof token).toBe("function");
    expect(typeof toolToken).toBe("function");
    expect(typeof channelToken).toBe("function");
    expect(typeof skillToken).toBe("function");
    expect(typeof MEMORY).toBe("string");
    expect(typeof GOVERNANCE).toBe("string");
    expect(typeof CREDENTIALS).toBe("string");
    expect(typeof EVENTS).toBe("string");
  });
});
