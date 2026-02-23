/**
 * @koi/engine-claude — Claude Agent SDK engine adapter (Layer 2).
 *
 * A non-cooperating EngineAdapter that delegates to the Claude Agent SDK's
 * query() function, mapping SDK messages to Koi EngineEvents. The SDK manages
 * its own model/tool calls internally; Koi tools are bridged via an in-process
 * MCP server.
 */

export type { SdkFunctions, SdkQuery, SdkQueryFn } from "./adapter.js";
export { createClaudeAdapter } from "./adapter.js";
export type {
  MapResult,
  MessageMapper,
  SdkAssistantMessage,
  SdkContentBlock,
  SdkMessage,
  SdkResultMessage,
  SdkStreamEvent,
  SdkStreamEventMessage,
  SdkSystemMessage,
  StreamEventMapper,
} from "./event-map.js";
export {
  createMessageMapper,
  createStreamEventMapper,
  mapAssistantMessage,
  mapResultMessage,
  mapSdkMessage,
  mapStopReason,
} from "./event-map.js";
export type { SdkResultFields } from "./metrics.js";
export { mapMetrics, mapRichMetadata } from "./metrics.js";
export type { McpBridgeConfig, SdkOptions } from "./policy-map.js";
export { buildSdkOptions } from "./policy-map.js";
export type { ToolBridgeDescriptor, ToolRegistry } from "./tool-bridge.js";
export { buildToolRegistry, createToolBridgeMcpServer, executeBridgedTool } from "./tool-bridge.js";
export type {
  ClaudeAdapterConfig,
  ClaudeEngineAdapter,
  ClaudeQueryControls,
  ClaudeSessionState,
} from "./types.js";
