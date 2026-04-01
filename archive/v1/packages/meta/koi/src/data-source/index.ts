/**
 * koi/data-source — Data source auto-discovery and skill generation.
 */

export type {
  ConnectorForgeConfig,
  ForgeDataSourceSkillsResult,
  SkillStrategy,
} from "@koi/connector-forge";
export {
  createGraphqlStrategy,
  createHttpStrategy,
  createMcpStrategy,
  createPostgresStrategy,
  forgeDataSourceSkills,
} from "@koi/connector-forge";

// Re-export L2 types for convenience
export type {
  ConsentCallbacks,
  DataSourceProbeResult,
  DiscoveryConfig,
  McpServerDescriptor,
  McpToolDescriptor,
} from "@koi/data-source-discovery";
export {
  discoverSources,
  probeEnv,
  probeManifest,
  probeMcp,
} from "@koi/data-source-discovery";
export type {
  DataSourceStackBundle,
  DataSourceStackConfig,
  ManifestDataSourceEntry,
  ResolvedDataSourceStackMeta,
} from "@koi/data-source-stack";
export { createDataSourceStack } from "@koi/data-source-stack";
