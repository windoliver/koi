/**
 * @koi/lsp — Language Server Protocol Integration (Layer 2)
 *
 * Bridges LSP servers into Koi's ECS tool system via ComponentProvider.
 * Supports any language with an LSP server (TypeScript, Python, Go, Rust, etc.).
 *
 * Depends on @koi/core (L0) and L0u utilities only — never on L1 or peer L2.
 */

// types — client
export type { CreateTransportFn, LspClient } from "./client.js";
// runtime values — client
export { createLspClient } from "./client.js";
// types — client pool
export type { LspClientPool, LspClientPoolConfig } from "./client-pool.js";
// runtime values — client pool
export { createLspClientPool, DEFAULT_LSP_CLIENT_POOL_CONFIG } from "./client-pool.js";
// types — component provider
export type {
  CreateClientFn,
  LspComponentProviderResult,
  LspServerFailure,
} from "./component-provider.js";
// runtime values — component provider
export { createLspComponentProvider } from "./component-provider.js";
// types — config
export type {
  LspProviderConfig,
  LspServerConfig,
  ResolvedLspProviderConfig,
  ResolvedLspServerConfig,
} from "./config.js";
// runtime values — config
export {
  resolveProviderConfig,
  resolveServerConfig,
  validateLspConfig,
} from "./config.js";
// runtime values — diagnostic adapter
export { createLspDiagnosticProvider } from "./diagnostic-adapter.js";
// runtime values — errors
export {
  capabilityNotSupportedError,
  connectionTimeoutError,
  isConnectionError,
  jsonRpcError,
  mapLspError,
  notConnectedError,
  reconnectExhaustedError,
  serverStartError,
} from "./errors.js";
// types — jsonrpc
export type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./jsonrpc.js";
// runtime values — jsonrpc
export { createJsonRpcConnection, createMessageParser, writeMessage } from "./jsonrpc.js";
// runtime values — language map
export { detectLanguageId } from "./language-map.js";
// types — server detection
export type { DetectedLspServer } from "./server-detection.js";
// runtime values — server detection
export { detectLspServers } from "./server-detection.js";
// runtime values — tool adapter
export { createLspTools } from "./tool-adapter.js";
// types — transport
export type { LspTransport } from "./transport.js";
// runtime values — transport
export { createStdioTransport } from "./transport.js";
// types — LSP protocol subset
export type {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  DocumentSymbol,
  HoverResult,
  Location,
  MarkupContent,
  Position,
  PublishDiagnosticsParams,
  Range,
  ReferenceContext,
  ReferenceParams,
  ServerCapabilities,
  SymbolInfo,
  SymbolKind,
  TextDocumentIdentifier,
  TextDocumentItem,
  TextDocumentPositionParams,
} from "./types.js";
