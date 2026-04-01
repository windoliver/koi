/**
 * @koi/mcp — MCP transport layer + connection management.
 *
 * Provides the transport abstraction, connection lifecycle state machine,
 * config validation, error mapping, and auth provider interface for
 * connecting to MCP servers.
 */

// Auth
export type { McpAuthProvider, UnauthorizedContext } from "./auth.js";
export { createBearerAuthProvider } from "./auth.js";

// Config
export type {
  HttpTransportConfig,
  McpServerConfig,
  McpTransportConfig,
  ResolvedMcpServerConfig,
  SseTransportConfig,
  StdioTransportConfig,
} from "./config.js";
export {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  mcpServerArraySchema,
  mcpServerConfigSchema,
  mcpTransportConfigSchema,
  resolveServerConfig,
  validateServerConfig,
  validateServerConfigs,
} from "./config.js";

// Connection
export type { ConnectionDeps, McpConnection, McpToolInfo } from "./connection.js";
export { createMcpConnection } from "./connection.js";

// Errors
export type { McpErrorContext } from "./errors.js";
export {
  connectionTimeoutError,
  mapMcpError,
  notConnectedError,
  reconnectExhaustedError,
  sessionExpiredError,
} from "./errors.js";

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
