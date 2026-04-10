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
// Component provider
export type { McpComponentProviderOptions } from "./component-provider.js";
export { createMcpComponentProvider } from "./component-provider.js";
// Config — external schema (CC-compatible)
// Config — internal types (Koi convention)
export type {
  ExternalServerConfig,
  HttpServerConfig,
  McpJsonConfig,
  McpOAuthExternalConfig,
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
export { discoverAuthServer } from "./oauth/discovery.js";
export type { PkceChallenge } from "./oauth/pkce.js";
export { createPkceChallenge } from "./oauth/pkce.js";
export type { OAuthAuthProvider, OAuthProviderOptions } from "./oauth/provider.js";
export { createOAuthAuthProvider } from "./oauth/provider.js";
export type { TokenManager, TokenManagerOptions } from "./oauth/tokens.js";
export { computeServerKey, createTokenManager } from "./oauth/tokens.js";
// OAuth
export type {
  AuthServerMetadata,
  McpOAuthConfig,
  OAuthRuntime,
  OAuthTokens,
} from "./oauth/types.js";
// Resolver
export type { McpResolver, McpResolverOptions, McpServerFailure } from "./resolver.js";
export { createMcpResolver } from "./resolver.js";
// Schema normalization
export { normalizeToolSchema } from "./schema.js";
// State
export type {
  AuthChallenge,
  TransportState,
  TransportStateListener,
  TransportStateMachine,
} from "./state.js";
export { createTransportStateMachine } from "./state.js";
// Tool adapter
export {
  mapMcpToolInfoToDescriptor,
  mapMcpToolToKoi,
  namespacedToolName,
  parseNamespacedToolName,
  validateServerName,
} from "./tool-adapter.js";
// Transport
export type {
  CreateTransportFn,
  CreateTransportOptions,
  KoiMcpTransport,
  TransportEvent,
  TransportEventListener,
} from "./transport.js";
export { createTransport } from "./transport.js";
