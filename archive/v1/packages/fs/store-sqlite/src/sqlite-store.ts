/**
 * SQLite-backed ForgeStore implementation.
 *
 * Uses bun:sqlite for single-node / CLI usage without a Nexus server.
 * Stores full BrickArtifact as JSON in a `data` column alongside
 * indexed columns for efficient search. Tags use a junction table
 * with AND-subset matching via correlated subquery.
 */

import type { Database } from "bun:sqlite";
import type {
  BrickArtifact,
  BrickId,
  BrickUpdate,
  ForgeQuery,
  ForgeStore,
  KoiError,
  Result,
} from "@koi/core";
import { notFound } from "@koi/core";
import { openDb, wrapSqlite } from "@koi/sqlite-utils";
import {
  applyBrickUpdate,
  createMemoryStoreChangeNotifier,
  matchesBrickQuery,
  sortBricks,
  validateBrickArtifact,
} from "@koi/validation";
import { applyMigrations } from "./schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface SqliteForgeStorePathConfig {
  readonly dbPath: string;
}

export interface SqliteForgeStoreDbConfig {
  readonly db: Database;
}

export type SqliteForgeStoreConfig = SqliteForgeStorePathConfig | SqliteForgeStoreDbConfig;

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Create a Database with optimized PRAGMAs for ForgeStore usage.
 * @deprecated Use `openDb` from `@koi/sqlite-utils` directly.
 */
export const openForgeDb: (dbPath: string) => Database = openDb;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface BrickRow {
  readonly data: string;
}

interface ExistsRow {
  readonly found: number;
}

function isPathConfig(config: SqliteForgeStoreConfig): config is SqliteForgeStorePathConfig {
  return "dbPath" in config;
}

/** Build SQL WHERE clauses for indexed columns that can be filtered in SQL. */
function buildSearchSql(query: ForgeQuery): {
  readonly sql: string;
  readonly params: readonly (string | number)[];
} {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (query.kind !== undefined) {
    conditions.push("b.kind = ?");
    params.push(query.kind);
  }
  if (query.scope !== undefined) {
    conditions.push("b.scope = ?");
    params.push(query.scope);
  }
  if (query.sandbox !== undefined) {
    conditions.push("b.sandbox = ?");
    params.push(query.sandbox ? 1 : 0);
  }
  if (query.lifecycle !== undefined) {
    conditions.push("b.lifecycle = ?");
    params.push(query.lifecycle);
  }
  if (query.createdBy !== undefined) {
    conditions.push("b.created_by = ?");
    params.push(query.createdBy);
  }
  if (query.text !== undefined) {
    conditions.push("(b.name LIKE ? COLLATE NOCASE OR b.description LIKE ? COLLATE NOCASE)");
    const pattern = `%${query.text}%`;
    params.push(pattern, pattern);
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  return { sql: `SELECT b.data FROM bricks b${where}`, params };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface SqliteForgeStore extends ForgeStore {
  readonly close: () => void;
  readonly dispose: () => void;
}

/**
 * Create a SQLite-backed ForgeStore.
 *
 * Accepts either a file path (creates and owns the Database) or an
 * injected Database instance (caller owns lifecycle). Applies schema
 * migrations on creation.
 */
export function createSqliteForgeStore(config: SqliteForgeStoreConfig): SqliteForgeStore {
  const ownsDb = isPathConfig(config);
  const db = ownsDb ? openDb(config.dbPath) : config.db;

  applyMigrations(db);

  // -- Prepared statements --------------------------------------------------

  const insertBrickStmt = db.query<
    void,
    [
      string,
      string,
      string,
      string,
      number,
      string,
      string,
      string,
      number,
      string,
      number,
      string,
      string,
      string,
      number | null,
    ]
  >(
    `INSERT OR REPLACE INTO bricks
       (id, kind, name, scope, sandbox, origin, capabilities_json, lifecycle, usage_count, created_by, created_at, version, description, data, trail_strength)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  /** Extract created_by and created_at from provenance for indexed columns. */
  function extractCreatedFields(brick: BrickArtifact): {
    readonly createdBy: string;
    readonly createdAt: number;
  } {
    return {
      createdBy: brick.provenance.metadata.agentId,
      createdAt: brick.provenance.metadata.startedAt,
    };
  }

  const loadDataStmt = db.query<BrickRow, [string]>("SELECT data FROM bricks WHERE id = ?");

  const existsStmt = db.query<ExistsRow, [string]>("SELECT 1 AS found FROM bricks WHERE id = ?");

  const deleteStmt = db.query<void, [string]>("DELETE FROM bricks WHERE id = ?");

  const deleteTagsStmt = db.query<void, [string]>("DELETE FROM brick_tags WHERE brick_id = ?");

  const insertTagStmt = db.query<void, [string, string]>(
    "INSERT INTO brick_tags (brick_id, tag) VALUES (?, ?)",
  );

  const updateStmt = db.query<
    void,
    [string, number, string, number, number | null, string, string]
  >(
    `UPDATE bricks SET lifecycle = ?, sandbox = ?, scope = ?, usage_count = ?, trail_strength = ?, data = ?
     WHERE id = ?`,
  );

  // --- watch notification (delegated to shared notifier) -------------------
  const notifier = createMemoryStoreChangeNotifier();

  // -- ForgeStore methods ---------------------------------------------------

  const saveBrickAndTags = db.transaction((brick: BrickArtifact, dataJson: string) => {
    const { createdBy, createdAt } = extractCreatedFields(brick);
    insertBrickStmt.run(
      brick.id,
      brick.kind,
      brick.name,
      brick.scope,
      brick.policy.sandbox ? 1 : 0,
      brick.origin,
      JSON.stringify(brick.policy.capabilities),
      brick.lifecycle,
      brick.usageCount,
      createdBy,
      createdAt,
      brick.version,
      brick.description,
      dataJson,
      brick.trailStrength ?? null,
    );
    deleteTagsStmt.run(brick.id);
    for (const tag of brick.tags) {
      insertTagStmt.run(brick.id, tag);
    }
  });

  const save = async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
    const dataJson = JSON.stringify(brick);
    const result = wrapSqlite(() => saveBrickAndTags(brick, dataJson), `save(${brick.id})`);
    if (result.ok) notifier.notify({ kind: "saved", brickId: brick.id });
    return result;
  };

  const load = async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
    const rowResult = wrapSqlite(() => loadDataStmt.get(id), `load(${id})`);
    if (!rowResult.ok) return rowResult;
    if (rowResult.value === null) {
      return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
    }
    const parsed: unknown = JSON.parse(rowResult.value.data);
    return validateBrickArtifact(parsed, `sqlite:${id}`);
  };

  const search = async (query: ForgeQuery): Promise<Result<readonly BrickArtifact[], KoiError>> => {
    return wrapSqlite(() => {
      const { sql, params } = buildSearchSql(query);
      const rows = db.query<BrickRow, (string | number)[]>(sql).all(...params);

      // Parse + validate, then post-filter for fields not indexed in SQL
      const validated: BrickArtifact[] = [];
      for (const row of rows) {
        const parsed: unknown = JSON.parse(row.data);
        const result = validateBrickArtifact(parsed, "sqlite:search");
        if (result.ok) {
          validated.push(result.value);
        }
      }
      const filtered = validated.filter((brick) => matchesBrickQuery(brick, query));
      const sorted = sortBricks(filtered, query, { nowMs: Date.now() });

      return query.limit !== undefined ? sorted.slice(0, query.limit) : sorted;
    }, "search");
  };

  const remove = async (id: BrickId): Promise<Result<void, KoiError>> => {
    const existsResult = wrapSqlite(() => existsStmt.get(id), `remove:exists(${id})`);
    if (!existsResult.ok) return existsResult;
    if (existsResult.value === null) {
      return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
    }
    const result = wrapSqlite(() => {
      deleteStmt.run(id);
    }, `remove(${id})`);
    if (result.ok) notifier.notify({ kind: "removed", brickId: id });
    return result;
  };

  const updateBrick = db.transaction(
    (id: BrickId, updates: BrickUpdate): Result<void, KoiError> => {
      const row = loadDataStmt.get(id);
      if (row === null) {
        return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
      }

      const parsed: unknown = JSON.parse(row.data);
      const validated = validateBrickArtifact(parsed, `sqlite:update:${id}`);
      if (!validated.ok) {
        return { ok: false, error: validated.error };
      }

      const updated = applyBrickUpdate(validated.value, updates);
      const dataJson = JSON.stringify(updated);

      updateStmt.run(
        updated.lifecycle,
        updated.policy.sandbox ? 1 : 0,
        updated.scope,
        updated.usageCount,
        updated.trailStrength ?? null,
        dataJson,
        id,
      );

      // Sync brick_tags when tags are updated
      if (updates.tags !== undefined) {
        deleteTagsStmt.run(id);
        for (const tag of updates.tags) {
          insertTagStmt.run(id, tag);
        }
      }

      return { ok: true, value: undefined };
    },
  );

  const update = async (id: BrickId, updates: BrickUpdate): Promise<Result<void, KoiError>> => {
    const result = wrapSqlite(() => updateBrick(id, updates), `update(${id})`);
    // wrapSqlite returns the Result from the transaction; unwrap to notify
    if (result.ok) {
      const inner = result.value;
      if (inner.ok) notifier.notify({ kind: "updated", brickId: id });
      return inner;
    }
    return result;
  };

  const exists = async (id: BrickId): Promise<Result<boolean, KoiError>> => {
    return wrapSqlite(() => existsStmt.get(id) !== null, `exists(${id})`);
  };

  const close = (): void => {
    try {
      db.run("PRAGMA optimize");
    } catch {
      // best-effort optimize before close
    }
    if (ownsDb) {
      db.close();
    }
  };

  return {
    save,
    load,
    search,
    remove,
    update,
    exists,
    close,
    dispose: close,
    watch: notifier.subscribe,
  };
}
