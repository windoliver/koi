/**
 * @koi/mcp — MCP Client Bridge (Layer 2)
 *
 * Connects to MCP-compatible tool servers (filesystem, GitHub, Slack, etc.)
 * and attaches discovered tools as Koi ECS components. Supports both
 * individual tool mode and discover mode (2 meta-tools).
 *
 * Depends on @koi/core only — never on L1 or peer L2 packages.
 */

// types — client manager
export type { McpClientManager, McpToolInfo } from "./client-manager.js";
// runtime values — client manager
export { createMcpClientManager } from "./client-manager.js";
// types — component provider
export type {
  CreateManagerFn,
  McpComponentProviderResult,
  McpServerFailure,
} from "./component-provider.js";
// runtime values — component provider
export { createMcpComponentProvider } from "./component-provider.js";
// types — config
export type {
  HttpTransportConfig,
  McpProviderConfig,
  McpServerConfig,
  McpServerMode,
  McpTransportConfig,
  ResolvedMcpProviderConfig,
  ResolvedMcpServerConfig,
  SseTransportConfig,
  StdioTransportConfig,
} from "./config.js";
// runtime values — config
export {
  resolveProviderConfig,
  resolveServerConfig,
  validateMcpProviderConfig,
  validateMcpServerConfig,
} from "./config.js";
export { createExecuteTool } from "./discover/execute-tool.js";
// runtime values — discover mode
export { createSearchTool } from "./discover/search-tool.js";
// runtime values — errors
export {
  connectionTimeoutError,
  mapMcpError,
  notConnectedError,
  reconnectExhaustedError,
  serverStartError,
} from "./errors.js";
// runtime values — resolver
export { createMcpResolver } from "./resolver.js";
// runtime values — tool adapter
export { mapMcpToolToKoi } from "./tool-adapter.js";
