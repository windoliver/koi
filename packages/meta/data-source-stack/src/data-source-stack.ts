import { forgeDataSourceSkills } from "@koi/connector-forge";
import type { ComponentProvider, DataSourceDescriptor, ForgeDemandSignal } from "@koi/core";
import { createDataSourceDiscoveryProvider, discoverSources } from "@koi/data-source-discovery";
import type { ForgeSkillInput } from "@koi/forge-types";
import type {
  DataSourceStackBundle,
  DataSourceStackConfig,
  ResolvedDataSourceStackMeta,
} from "./types.js";

/**
 * Creates a data source stack bundle that composes:
 * - Discovery: parallel probes (manifest, env, MCP) with dedup + consent
 * - ECS Provider: attaches DATA_SOURCES to agents
 * - Skill Generation: optional ForgeSkillInput generation per discovered source
 */
export async function createDataSourceStack(
  config: DataSourceStackConfig,
): Promise<DataSourceStackBundle> {
  const discoveryConfig = config.discoveryConfig;
  const shouldGenerateSkills = config.generateSkills !== false;

  // Phase 1: Discover data sources
  const sources: readonly DataSourceDescriptor[] = await discoverSources({
    manifestEntries: config.manifestEntries,
    env: config.env ?? process.env,
    mcpServers: config.mcpServers,
    consent: config.consent,
    config: discoveryConfig,
  });

  // Phase 2: Create ECS component provider
  const provider: ComponentProvider = createDataSourceDiscoveryProvider({
    discover: () => Promise.resolve(sources),
  });

  // Phase 3: Generate forge skill inputs from discovered sources
  let generatedSkillInputs: readonly ForgeSkillInput[] = [];
  if (shouldGenerateSkills && sources.length > 0) {
    const result = forgeDataSourceSkills(sources);
    generatedSkillInputs = result.inputs;
  }

  // Phase 4: Emit detection signals for demand-triggered forging
  if (config.onSourceDetected !== undefined) {
    for (const source of sources) {
      config.onSourceDetected(source);
    }
  }

  // Phase 5: Build demand signals for forge pipeline integration
  const emittedAt = Date.now();
  const demandSignals: readonly ForgeDemandSignal[] = sources.map(
    (source): ForgeDemandSignal => ({
      id: `ds-detected-${source.name}-${String(emittedAt)}`,
      kind: "forge_demand",
      trigger: {
        kind: "data_source_detected",
        sourceName: source.name,
        protocol: source.protocol,
      },
      confidence: 0.9,
      suggestedBrickKind: "skill",
      context: {
        failureCount: 0,
        failedToolCalls: [],
        taskDescription: `Auto-generate data access skill for ${source.name} (${source.protocol})`,
      },
      emittedAt,
    }),
  );

  const meta: ResolvedDataSourceStackMeta = {
    sourceCount: sources.length,
    generatedSkillCount: generatedSkillInputs.length,
    probesEnabled: {
      manifest: config.manifestEntries !== undefined,
      env: discoveryConfig?.enableEnvProbe !== false,
      mcp: discoveryConfig?.enableMcpProbe !== false && config.mcpServers !== undefined,
    },
  };

  return {
    provider,
    generatedSkillInputs,
    discoveredSources: sources,
    demandSignals,
    dispose: () => {},
    config: meta,
  };
}
