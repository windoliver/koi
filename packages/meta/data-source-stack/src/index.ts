/**
 * @koi/data-source-stack — Data source composition meta-package (Layer 3)
 *
 * Composes data source discovery, skill generation, and credential gating
 * into a single bundle.
 *
 * Usage:
 * ```typescript
 * import { createDataSourceStack } from "@koi/data-source-stack";
 *
 * const { provider, generatedSkillInputs, discoveredSources } = await createDataSourceStack({
 *   manifestEntries: manifest.dataSources,
 *   env: process.env,
 *   mcpServers: connectedServers,
 * });
 * ```
 */

export { createDataSourceStack } from "./data-source-stack.js";
export type {
  DataSourceStackBundle,
  DataSourceStackConfig,
  ManifestDataSourceEntry,
  ResolvedDataSourceStackMeta,
} from "./types.js";
