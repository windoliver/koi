/**
 * SQLite-backed ForgeStore implementation.
 *
 * Uses bun:sqlite for single-node / CLI usage without a Nexus server.
 * Stores full BrickArtifact as JSON in a `data` column alongside
 * indexed columns for efficient search. Tags use a junction table
 * with AND-subset matching via correlated subquery.
 */

import { Database } from "bun:sqlite";
import type {
  BrickArtifact,
  BrickUpdate,
  ForgeQuery,
  ForgeStore,
  KoiError,
  Result,
} from "@koi/core";
import { internal, notFound } from "@koi/core";
import { validateBrickArtifact } from "@koi/validation";
import { mapSqliteError, wrapSqlite } from "./errors.js";
import { applyMigrations } from "./schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 50;

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

/** Create a Database with optimized PRAGMAs for ForgeStore usage. */
export function openForgeDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA cache_size = -16000");
  db.run("PRAGMA temp_store = MEMORY");
  return db;
}

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface SqliteForgeStore extends ForgeStore {
  readonly close: () => void;
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
  const db = ownsDb ? openForgeDb(config.dbPath) : config.db;

  applyMigrations(db);

  // -- Prepared statements --------------------------------------------------

  const insertBrickStmt = db.query<
    void,
    [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      number,
      string,
      number,
      string,
      string,
      string,
    ]
  >(
    `INSERT OR REPLACE INTO bricks
       (id, kind, name, scope, trust_tier, lifecycle, content_hash, usage_count, created_by, created_at, version, description, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const loadDataStmt = db.query<BrickRow, [string]>("SELECT data FROM bricks WHERE id = ?");

  const existsStmt = db.query<ExistsRow, [string]>("SELECT 1 AS found FROM bricks WHERE id = ?");

  const deleteStmt = db.query<void, [string]>("DELETE FROM bricks WHERE id = ?");

  const deleteTagsStmt = db.query<void, [string]>("DELETE FROM brick_tags WHERE brick_id = ?");

  const insertTagStmt = db.query<void, [string, string]>(
    "INSERT INTO brick_tags (brick_id, tag) VALUES (?, ?)",
  );

  const updateStmt = db.query<void, [string, string, string, number, string, string]>(
    `UPDATE bricks SET lifecycle = ?, trust_tier = ?, scope = ?, usage_count = ?, data = ?
     WHERE id = ?`,
  );

  // --- onChange notification -------------------------------------------------
  const changeListeners = new Set<() => void>();
  // let justified: mutable timer ref for debounce
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const notifyListeners = (): void => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      for (const listener of changeListeners) {
        listener();
      }
    }, DEBOUNCE_MS);
  };

  const onChange = (listener: () => void): (() => void) => {
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  };

  // -- ForgeStore methods ---------------------------------------------------

  const saveBrickAndTags = db.transaction((brick: BrickArtifact, dataJson: string) => {
    insertBrickStmt.run(
      brick.id,
      brick.kind,
      brick.name,
      brick.scope,
      brick.trustTier,
      brick.lifecycle,
      brick.contentHash,
      brick.usageCount,
      brick.createdBy,
      brick.createdAt,
      brick.version,
      brick.description,
      dataJson,
    );
    deleteTagsStmt.run(brick.id);
    for (const tag of brick.tags) {
      insertTagStmt.run(brick.id, tag);
    }
  });

  const save = async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
    const dataJson = JSON.stringify(brick);
    const result = wrapSqlite(() => saveBrickAndTags(brick, dataJson), `save(${brick.id})`);
    if (result.ok) notifyListeners();
    return result;
  };

  const load = async (id: string): Promise<Result<BrickArtifact, KoiError>> => {
    const row = loadDataStmt.get(id);
    if (row === null) {
      return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
    }
    try {
      const parsed: unknown = JSON.parse(row.data);
      return validateBrickArtifact(parsed, `sqlite:${id}`);
    } catch (e: unknown) {
      return { ok: false, error: internal(`Failed to parse brick ${id}`, e) };
    }
  };

  const search = async (query: ForgeQuery): Promise<Result<readonly BrickArtifact[], KoiError>> => {
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
    if (query.trustTier !== undefined) {
      conditions.push("b.trust_tier = ?");
      params.push(query.trustTier);
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
    if (query.tags !== undefined && query.tags.length > 0) {
      // AND-subset: brick must have ALL requested tags
      conditions.push(
        `(SELECT COUNT(DISTINCT t.tag) FROM brick_tags t WHERE t.brick_id = b.id AND t.tag IN (${query.tags.map(() => "?").join(", ")})) = ?`,
      );
      for (const tag of query.tags) {
        params.push(tag);
      }
      params.push(query.tags.length);
    }

    let sql = "SELECT b.data FROM bricks b";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    if (query.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }

    try {
      const stmt = db.prepare<BrickRow, (string | number)[]>(sql);
      const rows = stmt.all(...params);
      stmt.finalize();

      const results: BrickArtifact[] = [];
      for (const row of rows) {
        const parsed: unknown = JSON.parse(row.data);
        const validated = validateBrickArtifact(parsed, "sqlite:search");
        if (validated.ok) {
          results.push(validated.value);
        }
      }
      return { ok: true, value: results };
    } catch (e: unknown) {
      return { ok: false, error: mapSqliteError(e, "search") };
    }
  };

  const remove = async (id: string): Promise<Result<void, KoiError>> => {
    const row = existsStmt.get(id);
    if (row === null) {
      return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
    }
    const result = wrapSqlite(() => {
      deleteStmt.run(id);
    }, `remove(${id})`);
    if (result.ok) notifyListeners();
    return result;
  };

  const updateBrick = db.transaction((id: string, updates: BrickUpdate): Result<void, KoiError> => {
    const row = loadDataStmt.get(id);
    if (row === null) {
      return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
    }

    const existing = JSON.parse(row.data) as Record<string, unknown>;
    const updated = {
      ...existing,
      ...(updates.lifecycle !== undefined ? { lifecycle: updates.lifecycle } : {}),
      ...(updates.trustTier !== undefined ? { trustTier: updates.trustTier } : {}),
      ...(updates.scope !== undefined ? { scope: updates.scope } : {}),
      ...(updates.usageCount !== undefined ? { usageCount: updates.usageCount } : {}),
      ...(updates.tags !== undefined ? { tags: updates.tags } : {}),
    };
    const dataJson = JSON.stringify(updated);

    updateStmt.run(
      updated.lifecycle as string,
      updated.trustTier as string,
      updated.scope as string,
      updated.usageCount as number,
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
  });

  const update = async (id: string, updates: BrickUpdate): Promise<Result<void, KoiError>> => {
    try {
      const result = updateBrick(id, updates);
      if (result.ok) notifyListeners();
      return result;
    } catch (e: unknown) {
      return { ok: false, error: mapSqliteError(e, `update(${id})`) };
    }
  };

  const exists = async (id: string): Promise<Result<boolean, KoiError>> => {
    const row = existsStmt.get(id);
    return { ok: true, value: row !== null };
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

  return { save, load, search, remove, update, exists, close, onChange };
}
