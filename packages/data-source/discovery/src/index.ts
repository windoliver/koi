/**
 * @koi/data-source-discovery — auto-discover data sources from manifest,
 * environment variables, and MCP servers.
 */

// Discovery orchestrator
export type { DiscoverSourcesInput } from "./discovery.js";
export { discoverSources } from "./discovery.js";
export { probeEnv } from "./probes/env.js";
// Individual probes (for direct use by consumers/tests)
export type { ManifestDataSourceEntry } from "./probes/manifest.js";
export { probeManifest } from "./probes/manifest.js";
export { probeMcp } from "./probes/mcp.js";
// Component provider
export type { DataSourceDiscoveryProviderConfig } from "./provider.js";
export { createDataSourceDiscoveryProvider } from "./provider.js";
// Types
export type {
  ConsentCallbacks,
  ConsentDecision,
  DataSourceProbeResult,
  DiscoveryConfig,
  McpServerDescriptor,
  McpToolDescriptor,
} from "./types.js";
export { DEFAULT_DISCOVERY_CONFIG } from "./types.js";
