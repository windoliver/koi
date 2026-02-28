/**
 * @koi/agent-discovery — Runtime discovery of external coding agents.
 *
 * L2 package. Discovers agents from PATH, filesystem registry, and MCP servers.
 */

// Re-export L0 types for consumer convenience
export type {
  ExternalAgentDescriptor,
  ExternalAgentSource,
  ExternalAgentTransport,
} from "@koi/core";

// Provider factory
export { createDiscoveryProvider } from "./component-provider.js";
// Constants
export {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
  KNOWN_CLI_AGENTS,
  SOURCE_PRIORITY,
} from "./constants.js";
// Tool factory
export { createDiscoverAgentsTool } from "./discover-agents-tool.js";
export type { DiscoverAgentsOptions, DiscoveryHandle } from "./discovery.js";
// Core discovery
export { createDiscovery } from "./discovery.js";
// Health checks
export { checkAgentHealth } from "./health.js";
export { createFilesystemSource } from "./sources/filesystem-scanner.js";
export { createMcpSource } from "./sources/mcp-scanner.js";
export type { PathSourceConfig } from "./sources/path-scanner.js";
// Source factories
export { createPathSource } from "./sources/path-scanner.js";
// Types
export type {
  DiscoveryFilter,
  DiscoveryProviderConfig,
  DiscoverySource,
  HealthCheckResult,
  KnownCliAgent,
  McpAgentSource,
  McpToolInfo,
  SystemCalls,
} from "./types.js";
