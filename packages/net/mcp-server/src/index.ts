/**
 * @koi/mcp-server — Expose agent tools and platform capabilities via MCP.
 */

// Config
export type { McpServerConfig, PlatformCapabilities } from "./config.js";
// Error utilities
export { sanitizeMcpError } from "./errors.js";
// Handler registration (for advanced use)
export { registerHandlers } from "./handler.js";
// Platform tools (for testing)
export { createPlatformTools } from "./platform-tools.js";
// Server
export type { McpServer } from "./server.js";
export { createMcpServer } from "./server.js";
// Tool cache (for testing / extension)
export type { ToolCache, ToolCacheConfig, ToolCacheEntry } from "./tool-cache.js";
export { createToolCache } from "./tool-cache.js";
// Transport
export { createStdioServerTransport } from "./transport.js";
