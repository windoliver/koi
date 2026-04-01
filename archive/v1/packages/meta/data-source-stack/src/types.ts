import type { QueryDataSourceResult } from "@koi/connector-forge";
import type {
  ComponentProvider,
  CredentialComponent,
  DataSourceDescriptor,
  ForgeDemandSignal,
  SkillComponent,
  Tool,
} from "@koi/core";
import type {
  ConsentCallbacks,
  DiscoveryConfig,
  McpServerDescriptor,
} from "@koi/data-source-discovery";
import type { ForgeSkillInput } from "@koi/forge-types";

/** Executor callback — delegates actual data-source I/O (SQL, HTTP, etc.) to the runtime. */
export type DataSourceExecutor = (
  source: DataSourceDescriptor,
  query: unknown,
  credential: string | undefined,
) => Promise<QueryDataSourceResult>;

export interface DataSourceStackConfig {
  /** Manifest-declared data sources (from LoadedManifest.dataSources). */
  readonly manifestEntries?: readonly ManifestDataSourceEntry[] | undefined;
  /** Environment variables to scan. Defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Connected MCP servers to probe for data tools. */
  readonly mcpServers?: readonly McpServerDescriptor[] | undefined;
  /** User consent callbacks — approve each discovered source before registration. */
  readonly consent?: ConsentCallbacks | undefined;
  /** Discovery probe configuration (timeouts, patterns, enable/disable). */
  readonly discoveryConfig?: DiscoveryConfig | undefined;
  /** Whether to auto-generate forge skills from discovered data sources. Default: true. */
  readonly generateSkills?: boolean | undefined;
  /** Called for each discovered data source — enables demand-triggered skill forging. */
  readonly onSourceDetected?: (source: DataSourceDescriptor) => void;
  /** Credential component for runtime auth resolution by query_datasource/probe_schema tools. */
  readonly credentials?: CredentialComponent | undefined;
  /** Executor for actual data-source I/O. When omitted, tools use a built-in SQL executor (Bun.sql). */
  readonly executor?: DataSourceExecutor | undefined;
}

/** Simplified manifest data source entry (avoids L2 @koi/manifest import). */
export interface ManifestDataSourceEntry {
  readonly name: string;
  readonly protocol: string;
  readonly description?: string | undefined;
  readonly auth?:
    | {
        readonly kind: string;
        readonly ref: string;
        readonly scopes?: readonly string[] | undefined;
      }
    | undefined;
  readonly allowedHosts?: readonly string[] | undefined;
}

export interface DataSourceStackBundle {
  readonly provider: ComponentProvider;
  /** Runtime tools: query_datasource + probe_schema with real executors. */
  readonly tools: readonly Tool[];
  /** Generated skill components — attached to agents via the provider. */
  readonly skillComponents: readonly SkillComponent[];
  readonly generatedSkillInputs: readonly ForgeSkillInput[];
  readonly discoveredSources: readonly DataSourceDescriptor[];
  /** Demand signals for demand-triggered forge pipeline integration. */
  readonly demandSignals: readonly ForgeDemandSignal[];
  readonly dispose: () => void;
  readonly config: ResolvedDataSourceStackMeta;
}

export interface ResolvedDataSourceStackMeta {
  readonly sourceCount: number;
  readonly generatedSkillCount: number;
  readonly probesEnabled: {
    readonly manifest: boolean;
    readonly env: boolean;
    readonly mcp: boolean;
  };
}
