/**
 * Built-in SQL executor using Bun's native postgres driver.
 *
 * Executes parameterized queries only — no string concatenation.
 * Falls back to error result for non-SQL protocols.
 */

import type { QueryDataSourceResult } from "@koi/connector-forge";
import type { DataSourceDescriptor } from "@koi/core";

/**
 * Default SQL executor — uses the credential as a connection string
 * to execute parameterized queries via Bun's native SQL support.
 *
 * Only handles "sql" protocol queries. Returns error for other protocols.
 */
export async function executeSqlQuery(
  source: DataSourceDescriptor,
  query: unknown,
  credential: string | undefined,
): Promise<QueryDataSourceResult> {
  if (typeof query !== "object" || query === null) {
    return { ok: false, error: "Invalid query object" };
  }

  const q = query as {
    readonly protocol?: string;
    readonly query?: string;
    readonly params?: readonly unknown[];
  };

  if (q.protocol !== "sql") {
    return {
      ok: false,
      error: `Built-in executor only supports SQL protocol, got: ${q.protocol ?? "unknown"}`,
    };
  }

  if (typeof q.query !== "string") {
    return { ok: false, error: "SQL query must be a string" };
  }

  if (credential === undefined) {
    return {
      ok: false,
      error: `No credential available for source "${source.name}" — cannot connect`,
    };
  }

  try {
    // Use Bun's native SQL with parameterized query via raw()
    const { SQL } = await import("bun");
    const sql = new SQL(credential);
    const params = Array.isArray(q.params) ? q.params : [];
    // sql.unsafe() allows arbitrary SQL with parameter binding
    const result = await sql.unsafe(q.query, params);
    sql.close();

    const rows = Array.isArray(result) ? result : [];
    return {
      ok: true,
      data: {
        rows,
        rowCount: rows.length,
      },
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `SQL execution failed: ${message}` };
  }
}
