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
// ecs — types
export type {
  Agent,
  ComponentProvider,
  CredentialComponent,
  EventComponent,
  GovernanceComponent,
  GovernanceUsage,
  MemoryComponent,
  ProcessId,
  ProcessState,
  SkillMetadata,
  SpawnCheck,
  SubsystemToken,
  Tool,
  ToolDescriptor,
  TrustTier,
} from "./ecs.js";
// ecs — runtime values (token factories + well-known constants)
export {
  CREDENTIALS,
  channelToken,
  EVENTS,
  GOVERNANCE,
  MEMORY,
  skillToken,
  token,
  toolToken,
} from "./ecs.js";
// engine
export type {
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineMetrics,
  EngineOutput,
  EngineState,
  EngineStopReason,
} from "./engine.js";
// errors
export type { KoiError, KoiErrorCode, Result } from "./errors.js";
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
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "./middleware.js";
// resolver
export type { Resolver } from "./resolver.js";
