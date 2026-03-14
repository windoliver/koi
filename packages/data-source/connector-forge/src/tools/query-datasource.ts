import type { DataSourceDescriptor } from "@koi/core";

// ---------------------------------------------------------------------------
// Protocol-discriminated query types
// ---------------------------------------------------------------------------

export type DataSourceQuery =
  | {
      readonly protocol: "sql";
      readonly query: string;
      readonly params: readonly unknown[];
    }
  | {
      readonly protocol: "http";
      readonly method: string;
      readonly path: string;
      readonly body?: unknown;
    }
  | {
      readonly protocol: "graphql";
      readonly query: string;
      readonly variables?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly protocol: "mcp";
      readonly toolName: string;
      readonly args: Readonly<Record<string, unknown>>;
    };

export interface QueryDataSourceInput {
  readonly sourceName: string;
  readonly query: DataSourceQuery;
}

export interface QueryDataSourceResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** SQL protocols that support the "sql" query protocol. */
const SQL_PROTOCOLS = new Set(["postgres", "mysql", "sqlite"]);

/**
 * Validates a query_datasource input against the known data sources.
 * Returns the resolved source if the input is valid.
 */
export function validateQueryInput(
  input: QueryDataSourceInput,
  sources: readonly DataSourceDescriptor[],
):
  | { readonly ok: true; readonly source: DataSourceDescriptor }
  | { readonly ok: false; readonly error: string } {
  const source = sources.find((s) => s.name === input.sourceName);
  if (source === undefined) {
    return { ok: false, error: `Unknown data source: ${input.sourceName}` };
  }

  // Validate protocol matches
  if (input.query.protocol === "sql" && !SQL_PROTOCOLS.has(source.protocol)) {
    return {
      ok: false,
      error: `SQL queries not supported for protocol: ${source.protocol}`,
    };
  }

  // SQL injection prevention: params must be used, query must not contain string interpolation markers
  if (input.query.protocol === "sql") {
    if (
      input.query.query.includes("${") ||
      input.query.query.includes("' +") ||
      input.query.query.includes('" +')
    ) {
      return {
        ok: false,
        error: "SQL query contains string interpolation markers — use parameterized queries",
      };
    }
  }

  return { ok: true, source };
}
