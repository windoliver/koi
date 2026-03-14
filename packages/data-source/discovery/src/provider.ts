/**
 * ECS ComponentProvider that attaches discovered data sources to an agent.
 */

import type { AttachResult, ComponentProvider, DataSourceDescriptor } from "@koi/core";
import { DATA_SOURCES } from "@koi/core";

/** Configuration for the data source discovery provider. */
export interface DataSourceDiscoveryProviderConfig {
  readonly discover: () => Promise<readonly DataSourceDescriptor[]>;
}

/**
 * Create a ComponentProvider that discovers data sources and attaches
 * them to an agent via the DATA_SOURCES ECS token.
 */
export function createDataSourceDiscoveryProvider(
  config: DataSourceDiscoveryProviderConfig,
): ComponentProvider {
  return {
    name: "@koi/data-source-discovery",
    async attach(): Promise<AttachResult> {
      const sources = await config.discover();
      const components = new Map<string, unknown>();

      if (sources.length > 0) {
        components.set(DATA_SOURCES as string, sources);
      }

      return {
        components,
        skipped: [],
      };
    },
  };
}
