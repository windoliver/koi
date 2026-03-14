/**
 * Built-in multi-protocol data source executor.
 *
 * - SQL: Bun.SQL with parameterized queries
 * - HTTP: fetch() with credential as Bearer token
 * - GraphQL: fetch() with query + variables body
 * - MCP: returns structured error (MCP execution requires the MCP bridge)
 */

import type { QueryDataSourceResult } from "@koi/connector-forge";
import type { DataSourceDescriptor } from "@koi/core";

/**
 * Default multi-protocol executor for data source queries.
 */
export async function executeDataSourceQuery(
  source: DataSourceDescriptor,
  query: unknown,
  credential: string | undefined,
): Promise<QueryDataSourceResult> {
  if (typeof query !== "object" || query === null) {
    return { ok: false, error: "Invalid query object" };
  }

  const q = query as Readonly<Record<string, unknown>>;
  const protocol = q.protocol as string | undefined;

  switch (protocol) {
    case "sql":
      return executeSql(source, q, credential);
    case "http":
      return executeHttp(source, q, credential);
    case "graphql":
      return executeGraphql(source, q, credential);
    case "mcp":
      return {
        ok: false,
        error: `MCP protocol execution requires the MCP bridge — use the underlying MCP tool "${source.mcpToolName ?? source.name}" directly`,
      };
    default:
      return { ok: false, error: `Unsupported protocol: ${protocol ?? "unknown"}` };
  }
}

// ---------------------------------------------------------------------------
// SQL executor
// ---------------------------------------------------------------------------

async function executeSql(
  source: DataSourceDescriptor,
  q: Readonly<Record<string, unknown>>,
  credential: string | undefined,
): Promise<QueryDataSourceResult> {
  const queryStr = q.query;
  if (typeof queryStr !== "string") {
    return { ok: false, error: "SQL query must be a string" };
  }

  if (credential === undefined) {
    return {
      ok: false,
      error: `No credential available for source "${source.name}" — cannot connect`,
    };
  }

  // let justified: assigned in try, closed in finally
  let sqlClient: { close: () => void } | undefined;
  try {
    const { SQL } = await import("bun");
    const sql = new SQL(credential);
    sqlClient = sql;
    const params = Array.isArray(q.params) ? q.params : [];
    const result = await sql.unsafe(queryStr, params);
    const rows = Array.isArray(result) ? result : [];
    return { ok: true, data: { rows, rowCount: rows.length } };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `SQL execution failed: ${message}` };
  } finally {
    sqlClient?.close();
  }
}

// ---------------------------------------------------------------------------
// HTTP executor
// ---------------------------------------------------------------------------

async function executeHttp(
  source: DataSourceDescriptor,
  q: Readonly<Record<string, unknown>>,
  credential: string | undefined,
): Promise<QueryDataSourceResult> {
  const method = (q.method as string | undefined) ?? "GET";
  const path = q.path as string | undefined;
  if (typeof path !== "string") {
    return { ok: false, error: "HTTP query requires a path string" };
  }

  const baseUrl = source.endpoint ?? "";
  const url = baseUrl + path;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (credential !== undefined) {
    headers.Authorization = `Bearer ${credential}`;
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(q.body !== undefined ? { body: JSON.stringify(q.body) } : {}),
    });
    const data: unknown = await response.json();
    return {
      ok: response.ok,
      data,
      ...(response.ok ? {} : { error: `HTTP ${String(response.status)}` }),
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `HTTP request failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// GraphQL executor
// ---------------------------------------------------------------------------

async function executeGraphql(
  source: DataSourceDescriptor,
  q: Readonly<Record<string, unknown>>,
  credential: string | undefined,
): Promise<QueryDataSourceResult> {
  const queryStr = q.query;
  if (typeof queryStr !== "string") {
    return { ok: false, error: "GraphQL query must be a string" };
  }

  const endpoint = source.endpoint;
  if (endpoint === undefined) {
    return { ok: false, error: `No endpoint configured for GraphQL source "${source.name}"` };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (credential !== undefined) {
    headers.Authorization = `Bearer ${credential}`;
  }

  try {
    const body = JSON.stringify({
      query: queryStr,
      ...(q.variables !== undefined ? { variables: q.variables } : {}),
    });
    const response = await fetch(endpoint, { method: "POST", headers, body });
    const data: unknown = await response.json();
    return { ok: response.ok, data };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `GraphQL request failed: ${message}` };
  }
}
