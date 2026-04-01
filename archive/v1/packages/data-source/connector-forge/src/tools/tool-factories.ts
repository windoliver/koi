/**
 * Runtime Tool factories for query_datasource and probe_schema.
 *
 * These create actual @koi/core Tool objects that can be attached to agents
 * via ComponentProvider. The tools validate input, resolve credentials,
 * and delegate execution to the sandbox stack.
 */

import type {
  CredentialComponent,
  DataSourceDescriptor,
  JsonObject,
  Tool,
  ToolDescriptor,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { getSchemaProbeQuery } from "./probe-schema.js";
import type { DataSourceQuery, QueryDataSourceResult } from "./query-datasource.js";
import { validateQueryInput } from "./query-datasource.js";

// ---------------------------------------------------------------------------
// query_datasource tool
// ---------------------------------------------------------------------------

export interface QueryDataSourceToolConfig {
  /** Discovered data sources — used for validation and credential resolution. */
  readonly sources: readonly DataSourceDescriptor[];
  /** Credential component — resolves auth refs at runtime. */
  readonly credentials?: CredentialComponent;
  /** Executor function — called with validated query + resolved credential.
   * When undefined, the tool returns the validated query for inspection. */
  readonly execute?: (
    source: DataSourceDescriptor,
    query: DataSourceQuery,
    credential: string | undefined,
  ) => Promise<QueryDataSourceResult>;
}

const QUERY_DATASOURCE_DESCRIPTOR: ToolDescriptor = {
  name: "query_datasource",
  description:
    "Execute a query against a discovered data source. Supports SQL (parameterized), HTTP, GraphQL, and MCP protocols.",
  inputSchema: {
    type: "object",
    properties: {
      sourceName: {
        type: "string",
        description: "Name of the discovered data source",
      },
      query: {
        type: "object",
        description:
          'Protocol-discriminated query: { protocol: "sql", query, params } | { protocol: "http", method, path } | { protocol: "graphql", query, variables } | { protocol: "mcp", toolName, args }',
      },
    },
    required: ["sourceName", "query"],
  },
};

export function createQueryDataSourceTool(config: QueryDataSourceToolConfig): Tool {
  return {
    descriptor: QUERY_DATASOURCE_DESCRIPTOR,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    async execute(input: JsonObject): Promise<unknown> {
      const sourceName = input.sourceName as string | undefined;
      const query = input.query as DataSourceQuery | undefined;

      if (sourceName === undefined || query === undefined) {
        return { ok: false, error: "Missing required fields: sourceName, query" };
      }

      const validation = validateQueryInput({ sourceName, query }, config.sources);
      if (!validation.ok) {
        return { ok: false, error: validation.error };
      }

      // Resolve credential if source requires auth
      let credential: string | undefined;
      if (validation.source.auth !== undefined && config.credentials !== undefined) {
        credential = await config.credentials.get(validation.source.auth.ref);
        if (credential === undefined) {
          return {
            ok: false,
            error: `Credential not available for ${sourceName} (ref: ${validation.source.auth.ref})`,
          };
        }
      }

      // Delegate to executor or return validated query for inspection
      if (config.execute !== undefined) {
        return config.execute(validation.source, query, credential);
      }

      // No executor — return validated query metadata (dry run)
      return {
        ok: true,
        data: {
          sourceName,
          protocol: query.protocol,
          source: { name: validation.source.name, protocol: validation.source.protocol },
          credentialResolved: credential !== undefined,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// probe_schema tool
// ---------------------------------------------------------------------------

export interface ProbeSchemaToolConfig {
  /** Discovered data sources. */
  readonly sources: readonly DataSourceDescriptor[];
  /** Credential component. */
  readonly credentials?: CredentialComponent;
  /** Executor for running the schema probe query. */
  readonly execute?: (
    source: DataSourceDescriptor,
    probeQuery: string,
    credential: string | undefined,
  ) => Promise<unknown>;
}

const PROBE_SCHEMA_DESCRIPTOR: ToolDescriptor = {
  name: "probe_schema",
  description:
    "Probe the schema of a discovered data source. Returns table/column structure for SQL sources.",
  inputSchema: {
    type: "object",
    properties: {
      sourceName: {
        type: "string",
        description: "Name of the discovered data source to probe",
      },
    },
    required: ["sourceName"],
  },
};

export function createProbeSchemaToolTool(config: ProbeSchemaToolConfig): Tool {
  return {
    descriptor: PROBE_SCHEMA_DESCRIPTOR,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    async execute(input: JsonObject): Promise<unknown> {
      const sourceName = input.sourceName as string | undefined;
      if (sourceName === undefined) {
        return { ok: false, error: "Missing required field: sourceName" };
      }

      const source = config.sources.find((s) => s.name === sourceName);
      if (source === undefined) {
        return { ok: false, error: `Unknown data source: ${sourceName}` };
      }

      const probeQuery = getSchemaProbeQuery(source.protocol);
      if (probeQuery === undefined) {
        return {
          ok: false,
          error: `Schema probing not supported for protocol: ${source.protocol}`,
        };
      }

      // Resolve credential
      let credential: string | undefined;
      if (source.auth !== undefined && config.credentials !== undefined) {
        credential = await config.credentials.get(source.auth.ref);
      }

      if (config.execute !== undefined) {
        return config.execute(source, probeQuery, credential);
      }

      // No executor — return the probe query for inspection
      return {
        ok: true,
        data: {
          sourceName,
          protocol: source.protocol,
          probeQuery,
          credentialResolved: credential !== undefined,
        },
      };
    },
  };
}
