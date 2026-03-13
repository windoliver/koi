import {
  createProbeSchemaToolTool,
  createQueryDataSourceTool,
  forgeDataSourceSkills,
} from "@koi/connector-forge";
import type {
  ComponentProvider,
  DataSourceDescriptor,
  ForgeDemandSignal,
  SkillComponent,
  Tool,
} from "@koi/core";
import { DATA_SOURCES, skillToken } from "@koi/core";
import { discoverSources } from "@koi/data-source-discovery";
import type { ForgeSkillInput } from "@koi/forge-types";
import { executeSqlQuery } from "./sql-executor.js";
import type {
  DataSourceStackBundle,
  DataSourceStackConfig,
  ResolvedDataSourceStackMeta,
} from "./types.js";

/**
 * Creates a data source stack bundle that composes:
 * - Discovery: parallel probes (manifest, env, MCP) with dedup + consent
 * - ECS Provider: attaches DATA_SOURCES + generated skill components to agents
 * - Runtime Tools: query_datasource + probe_schema with real SQL executor
 * - Skill Generation: SkillComponent objects from discovered sources
 * - Demand Signals: data_source_detected triggers for forge pipeline
 */
export async function createDataSourceStack(
  config: DataSourceStackConfig,
): Promise<DataSourceStackBundle> {
  const discoveryConfig = config.discoveryConfig;
  const shouldGenerateSkills = config.generateSkills !== false;
  const executor = config.executor ?? executeSqlQuery;

  // Phase 1: Discover data sources
  const sources: readonly DataSourceDescriptor[] = await discoverSources({
    manifestEntries: config.manifestEntries,
    env: config.env ?? process.env,
    mcpServers: config.mcpServers,
    consent: config.consent,
    config: discoveryConfig,
  });

  // Phase 2: Create runtime tools with real executor
  // Build an env-based credential resolver as fallback when no CredentialComponent
  const envCredentials = config.credentials ?? {
    get: async (ref: string): Promise<string | undefined> => {
      return (config.env ?? process.env)[ref] ?? undefined;
    },
  };

  const tools: readonly Tool[] =
    sources.length > 0
      ? [
          createQueryDataSourceTool({
            sources,
            credentials: envCredentials,
            execute: (source, query, credential) => executor(source, query, credential),
          }),
          createProbeSchemaToolTool({
            sources,
            credentials: envCredentials,
            execute: (source, probeQuery, credential) =>
              executor(source, { protocol: "sql", query: probeQuery, params: [] }, credential),
          }),
        ]
      : [];

  // Phase 3: Generate skill inputs + SkillComponent objects
  let generatedSkillInputs: readonly ForgeSkillInput[] = [];
  const skillComponents: SkillComponent[] = [];
  if (shouldGenerateSkills && sources.length > 0) {
    const result = forgeDataSourceSkills(sources);
    generatedSkillInputs = result.inputs;

    // Build SkillComponents from generated inputs — mounted in-memory via provider
    for (const input of result.inputs) {
      skillComponents.push({
        name: input.name,
        description: input.description,
        content: input.body,
        tags: [...(input.tags ?? [])],
        ...(input.requires !== undefined ? { requires: input.requires } : {}),
      });
    }
  }

  // Phase 4: Create composite ECS provider (DATA_SOURCES + skill components)
  const provider: ComponentProvider = {
    name: "@koi/data-source-stack",
    async attach(): Promise<ReadonlyMap<string, unknown>> {
      const components = new Map<string, unknown>();

      // Attach DATA_SOURCES descriptor list
      components.set(DATA_SOURCES as string, sources);

      // Attach each generated skill as a named skill component
      for (const sc of skillComponents) {
        components.set(skillToken(sc.name) as string, sc);
      }

      return components;
    },
  };

  // Phase 5: Emit detection signals for demand-triggered forging
  if (config.onSourceDetected !== undefined) {
    for (const source of sources) {
      config.onSourceDetected(source);
    }
  }

  // Phase 6: Build demand signals for forge pipeline integration
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
    generatedSkillCount: skillComponents.length,
    probesEnabled: {
      manifest: config.manifestEntries !== undefined,
      env: discoveryConfig?.enableEnvProbe !== false,
      mcp: discoveryConfig?.enableMcpProbe !== false && config.mcpServers !== undefined,
    },
  };

  return {
    provider,
    tools,
    skillComponents,
    generatedSkillInputs,
    discoveredSources: sources,
    demandSignals,
    dispose: () => {},
    config: meta,
  };
}
