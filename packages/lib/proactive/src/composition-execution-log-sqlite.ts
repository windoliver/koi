import type {
  CompositionExecutionLog,
  CompositionExecutionStatus,
} from "./composition-executor.js";

/**
 * Minimal `node:sqlite`-compatible Database surface. Bun's `bun:sqlite` and
 * Node's `node:sqlite` (Node ≥22) both implement this shape, so callers can
 * pass either runtime's Database instance without an adapter.
 */
export interface SqliteDatabaseLike {
  readonly exec: (sql: string) => unknown;
  readonly prepare: (sql: string) => SqliteStatementLike;
}

/**
 * Structural subset of node:sqlite / bun:sqlite `Statement`. Parameters are
 * declared as the narrow string/null types this log actually binds, so both
 * runtime drivers' wider `SQLQueryBindings` types satisfy the contract via
 * contravariance.
 */
export interface SqliteStatementLike {
  readonly run: (...params: (string | null)[]) => unknown;
  readonly get: (...params: (string | null)[]) => unknown;
}

/**
 * Durable, restart-safe CompositionExecutionLog backed by SQLite.
 *
 * Schema:
 *   composition_execution_log(key TEXT PRIMARY KEY, kind TEXT NOT NULL, output TEXT)
 *
 * - `claim(key)` is atomic via INSERT OR IGNORE then SELECT.
 * - `record(key, output)` is idempotent (UPSERT). Output is JSON-encoded.
 * - `release(key)` is a DELETE.
 *
 * Output values must be JSON-serializable (the executor only stores
 * scheduler/notify return values, which are scalars or POJOs).
 */
export function sqliteCompositionExecutionLog(
  db: SqliteDatabaseLike,
  options?: { readonly tableName?: string },
): CompositionExecutionLog {
  const table = options?.tableName ?? "composition_execution_log";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(table)) {
    throw new Error(`sqliteCompositionExecutionLog: invalid tableName "${table}"`);
  }

  db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (` +
      `key TEXT PRIMARY KEY, ` +
      `kind TEXT NOT NULL CHECK (kind IN ('pending', 'complete')), ` +
      `output TEXT` +
      `)`,
  );

  const insertIgnore = db.prepare(
    `INSERT OR IGNORE INTO ${table} (key, kind, output) VALUES (?, 'pending', NULL)`,
  );
  const selectByKey = db.prepare(`SELECT kind, output FROM ${table} WHERE key = ?`);
  const upsertComplete = db.prepare(
    `INSERT INTO ${table} (key, kind, output) VALUES (?, 'complete', ?) ` +
      `ON CONFLICT(key) DO UPDATE SET kind = 'complete', output = excluded.output`,
  );
  const deleteByKey = db.prepare(`DELETE FROM ${table} WHERE key = ?`);

  // changes() reports rows affected by the most recent INSERT/UPDATE/DELETE.
  // SELECT does not modify the counter, so we can safely query it after
  // INSERT OR IGNORE to learn whether THIS call inserted (won the claim) or
  // not (prior call holds the row).
  const changesStmt = db.prepare("SELECT changes() AS n");

  return {
    claim: (key) => {
      insertIgnore.run(key);
      const inserted = (changesStmt.get() as { readonly n: number }).n > 0;
      if (inserted) {
        return { kind: "claimed" } satisfies CompositionExecutionStatus;
      }
      // Row pre-existed: either pending (prior attempt never finalized → fail
      // closed via "pending") or complete (replay short-circuit).
      const row = selectByKey.get(key) as
        | { readonly kind: "pending" | "complete"; readonly output: string | null }
        | undefined;
      if (row === undefined || row.kind === "pending") {
        return { kind: "pending" } satisfies CompositionExecutionStatus;
      }
      const output = row.output === null ? null : (JSON.parse(row.output) as unknown);
      return { kind: "complete", output } satisfies CompositionExecutionStatus;
    },
    record: (key, output) => {
      // JSON.stringify(undefined) is undefined → store as NULL.
      const encoded = output === undefined ? null : JSON.stringify(output);
      upsertComplete.run(key, encoded);
    },
    release: (key) => {
      deleteByKey.run(key);
    },
  };
}
