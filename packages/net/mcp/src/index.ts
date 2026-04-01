/**
 * @koi/mcp — MCP transport layer + connection management.
 *
 * Provides CC-compatible .mcp.json config loading, transport abstraction,
 * connection lifecycle state machine, error mapping, and auth provider
 * interface for connecting to MCP servers.
 */

// Auth
export type { McpAuthProvider } from "./auth.js";
export { createBearerAuthProvider } from "./auth.js";
// Config — external schema (CC-compatible)
// Config — internal types (Koi convention)
export type {
  ExternalServerConfig,
  HttpServerConfig,
  McpJsonConfig,
  McpServerConfig,
  McpTransportKind,
  NormalizeResult,
  ResolvedMcpServerConfig,
  ResolveOptions,
  SseServerConfig,
  StdioServerConfig,
} from "./config.js";
export {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  externalServerConfigSchema,
  mcpJsonSchema,
  normalizeMcpServers,
  resolveServerConfig,
  validateMcpJson,
} from "./config.js";

// Connection
export type { ConnectionDeps, McpConnection, McpToolInfo } from "./connection.js";
export { createMcpConnection } from "./connection.js";

// Env expansion
export { expandEnvVars, expandEnvVarsInRecord } from "./env.js";

// Errors
export type { McpErrorContext } from "./errors.js";
export {
  connectionTimeoutError,
  mapMcpError,
  notConnectedError,
  reconnectExhaustedError,
  sessionExpiredError,
} from "./errors.js";

// .mcp.json loader
export { loadMcpJsonFile, loadMcpJsonString } from "./mcp-json.js";

// State
export type {
  AuthChallenge,
  TransportState,
  TransportStateListener,
  TransportStateMachine,
} from "./state.js";
export { createTransportStateMachine } from "./state.js";

// Transport
export type {
  CreateTransportFn,
  CreateTransportOptions,
  KoiMcpTransport,
  TransportEvent,
  TransportEventListener,
} from "./transport.js";
export { createTransport } from "./transport.js";
