/**
 * @koi/acp-protocol — Shared ACP (Agent Client Protocol) primitives (L0u).
 *
 * Provides Zod schemas, JSON-RPC parser, transport interface, content mapping,
 * and event mapping used by both @koi/engine-acp (client) and @koi/acp (server).
 */

// --- acp-schema: wire types and parse functions ---
export type {
  AgentCapabilities,
  AnyRpcMessage,
  ClientCapabilities,
  ContentBlock,
  FsReadTextFileParams,
  FsReadTextFileResult,
  FsWriteTextFileParams,
  ImageContent,
  InitializeParams,
  InitializeResult,
  ParseError,
  ParseResult,
  PermissionOption,
  PermissionOutcome,
  RpcErrorObject,
  RpcId,
  SafeParseResult,
  SessionNewParams,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
  SessionRequestPermissionParams,
  SessionUpdateParams,
  SessionUpdatePayload,
  TerminalCreateParams,
  TerminalCreateResult,
  TerminalOutputResult,
  TerminalSessionParams,
  TerminalWaitForExitResult,
  TextContent,
  ToolCall,
  ToolCallKind,
  ToolCallStatus,
} from "./acp-schema.js";
export {
  parseAnyRpcMessage,
  parseFsReadTextFileParams,
  parseFsWriteTextFileParams,
  parseInitializeResult,
  parseSessionNewResult,
  parseSessionPromptResult,
  parseSessionRequestPermissionParams,
  parseSessionUpdateParams,
  parseTerminalCreateParams,
  parseTerminalSessionParams,
  safeParseFsReadTextFileParams,
  safeParseFsWriteTextFileParams,
  safeParseSessionRequestPermissionParams,
  safeParseTerminalCreateParams,
  safeParseTerminalSessionParams,
} from "./acp-schema.js";
// --- async-queue: push-to-pull bridge ---
export type { AsyncQueue } from "./async-queue.js";
export { createAsyncQueue } from "./async-queue.js";
// --- content-map: bidirectional Koi ↔ ACP content blocks ---
export { mapAcpContentToKoi, mapKoiContentToAcp } from "./content-map.js";
// --- event-map: bidirectional Koi ↔ ACP events ---
export { mapEngineEventToAcp, mapSessionUpdate } from "./event-map.js";
// --- json-rpc-parser: line parser, message types, serializers ---
export type {
  LineParser,
  RpcErrorCode,
  RpcErrorResponse,
  RpcInboundRequest,
  RpcMessage,
  RpcNotification,
  RpcSuccessResponse,
} from "./json-rpc-parser.js";
export {
  buildErrorResponse,
  buildRequest,
  buildResponse,
  createLineParser,
  RPC_ERROR_CODES,
} from "./json-rpc-parser.js";
// --- transport: shared interface ---
export type { AcpTransport } from "./transport.js";
