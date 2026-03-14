/**
 * Types for data source discovery — probe results, config, consent, MCP descriptors.
 */

import type { DataSourceDescriptor } from "@koi/core";

/** Result from a single discovery probe. */
export interface DataSourceProbeResult {
  readonly source: "manifest" | "env" | "mcp";
  readonly descriptor: DataSourceDescriptor;
}

/** Configuration for the discovery orchestrator. */
export interface DiscoveryConfig {
  readonly probeTimeoutMs?: number | undefined;
  readonly enableEnvProbe?: boolean | undefined;
  readonly enableMcpProbe?: boolean | undefined;
  readonly envPatterns?: readonly string[] | undefined;
}

/** Default discovery configuration values. */
export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  probeTimeoutMs: 5000,
  enableEnvProbe: true,
  enableMcpProbe: true,
  envPatterns: ["*DATABASE_URL*", "*_DSN", "*_CONNECTION_STRING"],
} as const satisfies DiscoveryConfig;

/** Consent callbacks — user must approve before a data source is registered. */
export interface ConsentCallbacks {
  readonly approve: (descriptor: DataSourceDescriptor) => boolean | Promise<boolean>;
}

/** MCP server descriptor for probing. */
export interface McpServerDescriptor {
  readonly name: string;
  readonly listTools: () => Promise<readonly McpToolDescriptor[]>;
}

/** A tool advertised by an MCP server. */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: Readonly<Record<string, unknown>> | undefined;
}
