/**
 * SQLite-backed BrickRegistry implementation.
 *
 * Stores full BrickArtifact JSON in a `data` column with indexed columns
 * for filtering. FTS5 contentless table for full-text search. Tags stored
 * in a junction table for AND-subset filtering.
 */

import type { Database } from "bun:sqlite";
import type {
  BrickArtifact,
  BrickKind,
  BrickPage,
  BrickRegistryBackend,
  BrickRegistryChangeEvent,
  BrickSearchQuery,
  KoiError,
  Result,
} from "@koi/core";
import { DEFAULT_BRICK_SEARCH_LIMIT, notFound } from "@koi/core";
import { wrapSqlite } from "@koi/sqlite-utils";
import type { RegistrySqliteConfig } from "./config.js";
import { resolveDb } from "./config.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { sanitizeFtsQuery } from "./fts-sanitize.js";
import { createListenerSet } from "./listeners.js";
import { applyRegistryMigrations } from "./schema.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface BrickRow {
  readonly rowid: number;
  readonly created_at: number;
  readonly data: string;
}

interface CountRow {
  readonly cnt: number;
}

// ---------------------------------------------------------------------------
// Search filter builder
// ---------------------------------------------------------------------------

interface FilterClause {
  readonly parts: readonly string[];
  readonly params: readonly (string | number)[];
}

/** Build WHERE filter parts for brick search (without cursor). */
function buildBrickFilter(db: Database, query: BrickSearchQuery): FilterClause | null {
  const parts: string[] = [];
  const params: (string | number)[] = [];

  if (query.text !== undefined && query.text.trim() !== "") {
    const sanitized = sanitizeFtsQuery(query.text);
    if (sanitized !== "") {
      const ftsRows = db
        .query<{ rowid: number }, [string]>("SELECT rowid FROM bricks_fts WHERE bricks_fts MATCH ?")
        .all(sanitized);
      if (ftsRows.length === 0) return null; // early exit — no matches
      parts.push(`b.rowid IN (${ftsRows.map((r) => r.rowid).join(",")})`);
    }
  }

  if (query.kind !== undefined) {
    parts.push("b.kind = ?");
    params.push(query.kind);
  }

  if (query.tags !== undefined && query.tags.length > 0) {
    const placeholders = query.tags.map(() => "?").join(", ");
    parts.push(
      `(SELECT COUNT(DISTINCT t.tag) FROM brick_tags t
        WHERE t.brick_rowid = b.rowid AND t.tag IN (${placeholders})) = ?`,
    );
    for (const tag of query.tags) {
      params.push(tag);
    }
    params.push(query.tags.length);
  }

  return { parts, params };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface SqliteBrickRegistry extends BrickRegistryBackend {
  readonly close: () => void;
}

export function createSqliteBrickRegistry(config: RegistrySqliteConfig): SqliteBrickRegistry {
  const { db, ownsDb } = resolveDb(config);
  applyRegistryMigrations(db);

  const listeners = createListenerSet<BrickRegistryChangeEvent>();

  // -------------------------------------------------------------------------
  // FTS helpers
  // -------------------------------------------------------------------------

  function insertFts(
    rowid: number,
    name: string,
    description: string,
    tags: readonly string[],
  ): void {
    db.run("INSERT INTO bricks_fts(rowid, name, description, tags) VALUES (?, ?, ?, ?)", [
      rowid,
      name,
      description,
      tags.join(" "),
    ]);
  }

  function deleteFts(rowid: number): void {
    db.run(
      "INSERT INTO bricks_fts(bricks_fts, rowid, name, description, tags) VALUES ('delete', ?, '', '', '')",
      [rowid],
    );
  }

  // -------------------------------------------------------------------------
  // Contract: register
  // -------------------------------------------------------------------------

  const register = (brick: BrickArtifact): Result<void, KoiError> => {
    const data = JSON.stringify(brick);
    const now = Date.now();

    /* let — justified: set inside transaction, read outside */
    let isUpdate = false;

    const result = wrapSqlite(() => {
      db.transaction(() => {
        const existing = db
          .query<{ rowid: number }, [string, string]>(
            "SELECT rowid FROM bricks WHERE kind = ? AND name = ?",
          )
          .get(brick.kind, brick.name);

        if (existing !== null) {
          isUpdate = true;
          db.run(
            `UPDATE bricks SET brick_id = ?, description = ?, scope = ?, sandbox = ?,
             lifecycle = ?, version = ?, usage_count = ?, created_at = ?, data = ?
             WHERE rowid = ?`,
            [
              brick.id,
              brick.description,
              brick.scope,
              brick.policy.sandbox ? 1 : 0,
              brick.lifecycle,
              brick.version,
              brick.usageCount,
              now,
              data,
              existing.rowid,
            ],
          );
          db.run("DELETE FROM brick_tags WHERE brick_rowid = ?", [existing.rowid]);
          for (const tag of brick.tags) {
            db.run("INSERT INTO brick_tags (brick_rowid, tag) VALUES (?, ?)", [
              existing.rowid,
              tag,
            ]);
          }
          deleteFts(existing.rowid);
          insertFts(existing.rowid, brick.name, brick.description, brick.tags);
        } else {
          db.run(
            `INSERT INTO bricks (brick_id, kind, name, description, scope, sandbox,
             lifecycle, version, usage_count, created_at, data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              brick.id,
              brick.kind,
              brick.name,
              brick.description,
              brick.scope,
              brick.policy.sandbox ? 1 : 0,
              brick.lifecycle,
              brick.version,
              brick.usageCount,
              now,
              data,
            ],
          );
          const inserted = db
            .query<{ rowid: number }, [string, string]>(
              "SELECT rowid FROM bricks WHERE kind = ? AND name = ?",
            )
            .get(brick.kind, brick.name);
          const newRowid = inserted?.rowid ?? 0;
          for (const tag of brick.tags) {
            db.run("INSERT INTO brick_tags (brick_rowid, tag) VALUES (?, ?)", [newRowid, tag]);
          }
          insertFts(newRowid, brick.name, brick.description, brick.tags);
        }
      })();
    }, "brick.register");

    if (!result.ok) return result;

    listeners.notify({
      kind: isUpdate ? "updated" : "registered",
      brickKind: brick.kind,
      name: brick.name,
    });

    return { ok: true, value: undefined };
  };

  // -------------------------------------------------------------------------
  // Contract: unregister
  // -------------------------------------------------------------------------

  const unregister = (kind: BrickKind, name: string): Result<void, KoiError> => {
    const existing = db
      .query<{ rowid: number }, [string, string]>(
        "SELECT rowid FROM bricks WHERE kind = ? AND name = ?",
      )
      .get(kind, name);

    if (existing === null) {
      return { ok: false, error: notFound(`${kind}:${name}`) };
    }

    const result = wrapSqlite(() => {
      db.transaction(() => {
        deleteFts(existing.rowid);
        db.run("DELETE FROM bricks WHERE rowid = ?", [existing.rowid]);
      })();
    }, "brick.unregister");

    if (!result.ok) return result;

    listeners.notify({ kind: "unregistered", brickKind: kind, name });
    return { ok: true, value: undefined };
  };

  // -------------------------------------------------------------------------
  // Contract: get
  // -------------------------------------------------------------------------

  const get = (kind: BrickKind, name: string): Result<BrickArtifact, KoiError> => {
    const row = db
      .query<{ data: string }, [string, string]>(
        "SELECT data FROM bricks WHERE kind = ? AND name = ?",
      )
      .get(kind, name);

    if (row === null) {
      return { ok: false, error: notFound(`${kind}:${name}`) };
    }

    return { ok: true, value: JSON.parse(row.data) as BrickArtifact };
  };

  // -------------------------------------------------------------------------
  // Contract: search
  // -------------------------------------------------------------------------

  const search = (query: BrickSearchQuery): BrickPage => {
    const limit = query.limit ?? DEFAULT_BRICK_SEARCH_LIMIT;
    const filter = buildBrickFilter(db, query);
    if (filter === null) return { items: [], total: 0 };

    const filterWhere = filter.parts.length > 0 ? `WHERE ${filter.parts.join(" AND ")}` : "";
    const countRow = db
      .prepare<CountRow, (string | number)[]>(`SELECT COUNT(*) as cnt FROM bricks b ${filterWhere}`)
      .get(...filter.params);
    const total = countRow?.cnt ?? 0;

    // Append cursor keyset condition for page query
    const pageParts = [...filter.parts];
    const pageParams: (string | number)[] = [...filter.params];
    if (query.cursor !== undefined) {
      const decoded = decodeCursor(query.cursor);
      if (decoded !== undefined) {
        pageParts.push("(b.created_at < ? OR (b.created_at = ? AND b.rowid < ?))");
        pageParams.push(decoded.sortKey, decoded.sortKey, decoded.rowid);
      }
    }

    const pageWhere = pageParts.length > 0 ? `WHERE ${pageParts.join(" AND ")}` : "";
    const rows = db
      .prepare<BrickRow, (string | number)[]>(
        `SELECT b.rowid, b.created_at, b.data FROM bricks b ${pageWhere}
         ORDER BY b.created_at DESC, b.rowid DESC LIMIT ?`,
      )
      .all(...pageParams, limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map((r) => JSON.parse(r.data) as BrickArtifact);
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow !== undefined
        ? encodeCursor(lastRow.created_at, lastRow.rowid)
        : undefined;

    const base = { items, total };
    return nextCursor !== undefined ? { ...base, cursor: nextCursor } : base;
  };

  // -------------------------------------------------------------------------
  // Contract: onChange
  // -------------------------------------------------------------------------

  const onChange = (listener: (event: BrickRegistryChangeEvent) => void): (() => void) => {
    return listeners.add(listener);
  };

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  const close = (): void => {
    listeners.clear();
    db.run("PRAGMA optimize");
    if (ownsDb) {
      db.close();
    }
  };

  return { register, unregister, get, search, onChange, close };
}
