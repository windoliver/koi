/**
 * Discovery orchestrator — runs probes in parallel, deduplicates results,
 * and gates on user consent before returning approved descriptors.
 */

import type { DataSourceDescriptor } from "@koi/core";
import { probeEnv } from "./probes/env.js";
import type { ManifestDataSourceEntry } from "./probes/manifest.js";
import { probeManifest } from "./probes/manifest.js";
import { probeMcp } from "./probes/mcp.js";
import type {
  ConsentCallbacks,
  DataSourceProbeResult,
  DiscoveryConfig,
  McpServerDescriptor,
} from "./types.js";
import { DEFAULT_DISCOVERY_CONFIG } from "./types.js";

/** Input for the discovery orchestrator. */
export interface DiscoverSourcesInput {
  readonly manifestEntries?: readonly ManifestDataSourceEntry[] | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly mcpServers?: readonly McpServerDescriptor[] | undefined;
  readonly consent?: ConsentCallbacks | undefined;
  readonly config?: DiscoveryConfig | undefined;
}

/** Source priority for deduplication — lower wins. */
const SOURCE_PRIORITY: Readonly<Record<string, number>> = {
  manifest: 0,
  env: 1,
  mcp: 2,
};

/**
 * Discover data sources from manifest, environment, and MCP servers.
 *
 * Runs all enabled probes in parallel, deduplicates by (protocol, name)
 * with manifest winning over env winning over mcp, then gates each
 * descriptor through the optional consent callback.
 */
export async function discoverSources(
  input: DiscoverSourcesInput,
): Promise<readonly DataSourceDescriptor[]> {
  const config: DiscoveryConfig = {
    ...DEFAULT_DISCOVERY_CONFIG,
    ...input.config,
  };
  const timeoutMs = config.probeTimeoutMs ?? 5000;
  const patterns = config.envPatterns ?? DEFAULT_DISCOVERY_CONFIG.envPatterns ?? [];

  // Parallel probes
  const probePromises: Promise<readonly DataSourceProbeResult[]>[] = [
    Promise.resolve(probeManifest(input.manifestEntries)),
  ];

  if (config.enableEnvProbe !== false && input.env !== undefined) {
    probePromises.push(Promise.resolve(probeEnv(input.env, patterns)));
  }

  if (config.enableMcpProbe !== false && input.mcpServers !== undefined) {
    probePromises.push(probeMcp(input.mcpServers, timeoutMs));
  }

  const settled = await Promise.allSettled(probePromises);
  const allResults: DataSourceProbeResult[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      allResults.push(...result.value);
    }
  }

  // Dedup by (protocol, name) — manifest wins over env, env wins over mcp
  const seen = new Map<string, DataSourceProbeResult>();

  for (const result of allResults) {
    const key = `${result.descriptor.protocol}:${result.descriptor.name}`;
    const existing = seen.get(key);
    if (
      existing === undefined ||
      (SOURCE_PRIORITY[result.source] ?? 99) < (SOURCE_PRIORITY[existing.source] ?? 99)
    ) {
      seen.set(key, result);
    }
  }

  // Consent gating
  const descriptors: DataSourceDescriptor[] = [];
  for (const result of seen.values()) {
    if (input.consent !== undefined) {
      const approved = await input.consent.approve(result.descriptor);
      if (!approved) continue;
    }
    descriptors.push(result.descriptor);
  }

  return descriptors;
}
