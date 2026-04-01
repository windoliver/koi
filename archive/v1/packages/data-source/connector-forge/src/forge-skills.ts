import type { DataSourceDescriptor } from "@koi/core";
import type { ForgeSkillInput } from "@koi/forge-types";
import { createGraphqlStrategy, createHttpStrategy } from "./strategies/http.js";
import { createMcpStrategy } from "./strategies/mcp.js";
import { createPostgresStrategy } from "./strategies/postgres.js";
import type { ConnectorForgeConfig, SkillStrategy } from "./types.js";
import { DEFAULT_CONNECTOR_FORGE_CONFIG } from "./types.js";

/** Registry of protocol -> strategy. */
function createDefaultStrategies(): ReadonlyMap<string, SkillStrategy> {
  const strategies: readonly SkillStrategy[] = [
    createPostgresStrategy(),
    createMcpStrategy(),
    createHttpStrategy(),
    createGraphqlStrategy(),
  ];
  return new Map(strategies.map((s) => [s.protocol, s]));
}

export interface ForgeDataSourceSkillsResult {
  readonly inputs: readonly ForgeSkillInput[];
  readonly skipped: readonly {
    readonly name: string;
    readonly reason: string;
  }[];
}

/**
 * Generates ForgeSkillInput for each discovered data source.
 * Selects strategy by protocol. Unknown protocols are skipped.
 */
export function forgeDataSourceSkills(
  descriptors: readonly DataSourceDescriptor[],
  config?: ConnectorForgeConfig,
): ForgeDataSourceSkillsResult {
  const _merged = { ...DEFAULT_CONNECTOR_FORGE_CONFIG, ...config };
  const strategies = createDefaultStrategies();

  const inputs: ForgeSkillInput[] = [];
  const skipped: { readonly name: string; readonly reason: string }[] = [];

  for (const descriptor of descriptors) {
    const strategy = strategies.get(descriptor.protocol);
    if (strategy === undefined) {
      skipped.push({
        name: descriptor.name,
        reason: `No strategy for protocol: ${descriptor.protocol}`,
      });
      continue;
    }

    inputs.push(strategy.generateInput(descriptor));
  }

  return { inputs, skipped };
}
