/**
 * @koi/mcp-server — Expose agent tools via MCP protocol.
 */

export { registerHandlers } from "./handler.js";
export type { McpServer, McpServerConfig } from "./server.js";
export { createMcpServer } from "./server.js";
export type { ToolCache, ToolCacheConfig, ToolCacheEntry } from "./tool-cache.js";
export { createToolCache } from "./tool-cache.js";
export { createStdioServerTransport } from "./transport.js";
