/**
 * SqliteArtifactStore — bun:sqlite backend for local persistent artifact storage.
 * Zero external dependencies (bun:sqlite is built into Bun).
 *
 * Schema: `artifacts` + `artifact_tags` (normalized for AND-match queries).
 * WAL mode + prepared statements + parameterized queries.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { JsonObject, KoiError, Result } from "@koi/core";
import type { ArtifactClient } from "./client.js";
import {
  conflictError,
  internalError,
  notFoundError,
  validateId,
  validateQuery,
} from "./errors.js";
import { computeContentHash } from "./hash.js";
import type {
  Artifact,
  ArtifactId,
  ArtifactPage,
  ArtifactQuery,
  ArtifactUpdate,
  ContentHash,
} from "./types.js";
import { artifactId, contentHash } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SqliteStoreConfig {
  /** Database file path, or ":memory:" for in-memory. */
  readonly dbPath: string;
}

// ---------------------------------------------------------------------------
// Row types (SQLite query results)
// ---------------------------------------------------------------------------

interface ArtifactRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly contentType: string;
  readonly contentHash: string | null;
  readonly sizeBytes: number;
  readonly metadata: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface TagRow {
  readonly tag: string;
}

interface TagWithIdRow {
  readonly artifactId: string;
  readonly tag: string;
}

interface CountRow {
  readonly count: number;
}

interface ExistsRow {
  readonly found: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape LIKE metacharacters so user input is treated as literal text. */
function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse JSON metadata with validation. Throws on corrupt data. */
function parseMetadata(raw: string, rowId: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Corrupt metadata JSON for artifact: ${rowId}`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`Metadata must be a JSON object for artifact: ${rowId}`);
  }
  return parsed;
}

function rowToArtifact(row: ArtifactRow, tags: readonly string[]): Artifact {
  return {
    id: artifactId(row.id),
    name: row.name,
    description: row.description,
    content: row.content,
    contentType: row.contentType,
    contentHash: row.contentHash !== null ? contentHash(row.contentHash) : undefined,
    sizeBytes: row.sizeBytes,
    metadata: parseMetadata(row.metadata, row.id),
    tags,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Search query builder
// ---------------------------------------------------------------------------

interface SearchWhere {
  readonly sql: string;
  readonly params: readonly SQLQueryBindings[];
}

const SORT_COLUMNS: Readonly<Record<string, string>> = {
  createdAt: "a.createdAt",
  updatedAt: "a.updatedAt",
  name: "a.name",
} as const;

function buildSearchWhere(query: ArtifactQuery): SearchWhere {
  const clauses: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (query.tags !== undefined && query.tags.length > 0) {
    const placeholders = query.tags.map(() => "?").join(", ");
    clauses.push(
      `a.id IN (SELECT artifactId FROM artifact_tags WHERE tag IN (${placeholders}) GROUP BY artifactId HAVING COUNT(DISTINCT tag) = ?)`,
    );
    params.push(...query.tags, query.tags.length);
  }

  if (query.createdBy !== undefined) {
    clauses.push("a.createdBy = ?");
    params.push(query.createdBy);
  }

  if (query.contentType !== undefined) {
    clauses.push("a.contentType = ?");
    params.push(query.contentType);
  }

  if (query.textSearch !== undefined && query.textSearch !== "") {
    clauses.push("lower(a.name || ' ' || a.description) LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLikePattern(query.textSearch.toLowerCase())}%`);
  }

  const sql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return { sql, params };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createSqliteArtifactStore(
  config: SqliteStoreConfig,
): ArtifactClient & { readonly close: () => void } {
  const db = new Database(config.dbPath);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA foreign_keys=ON");

  // -- Schema ---------------------------------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL,
      content     TEXT NOT NULL,
      contentType TEXT NOT NULL,
      contentHash TEXT,
      sizeBytes   INTEGER NOT NULL,
      metadata    TEXT NOT NULL DEFAULT '{}',
      createdBy   TEXT NOT NULL,
      createdAt   INTEGER NOT NULL,
      updatedAt   INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS artifact_tags (
      artifactId TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      tag        TEXT NOT NULL,
      PRIMARY KEY (artifactId, tag)
    )
  `);

  db.run("CREATE INDEX IF NOT EXISTS idx_artifacts_createdBy ON artifacts(createdBy)");
  db.run("CREATE INDEX IF NOT EXISTS idx_artifacts_contentType ON artifacts(contentType)");
  db.run("CREATE INDEX IF NOT EXISTS idx_artifacts_contentHash ON artifacts(contentHash)");
  db.run("CREATE INDEX IF NOT EXISTS idx_artifacts_createdAt ON artifacts(createdAt)");
  db.run("CREATE INDEX IF NOT EXISTS idx_artifacts_updatedAt ON artifacts(updatedAt)");
  db.run("CREATE INDEX IF NOT EXISTS idx_artifact_tags_tag ON artifact_tags(tag)");

  // -- Prepared statements (typed via bun:sqlite generics) ------------------
  const insertArtifactStmt = db.prepare(`
    INSERT INTO artifacts (id, name, description, content, contentType, contentHash, sizeBytes, metadata, createdBy, createdAt, updatedAt)
    VALUES ($id, $name, $description, $content, $contentType, $contentHash, $sizeBytes, $metadata, $createdBy, $createdAt, $updatedAt)
  `);

  const insertTagStmt = db.prepare(
    "INSERT INTO artifact_tags (artifactId, tag) VALUES ($artifactId, $tag)",
  );

  const selectArtifactStmt = db.query<ArtifactRow, [string]>(
    "SELECT * FROM artifacts WHERE id = ?",
  );

  const selectTagsStmt = db.query<TagRow, [string]>(
    "SELECT tag FROM artifact_tags WHERE artifactId = ? ORDER BY tag",
  );

  const deleteArtifactStmt = db.prepare("DELETE FROM artifacts WHERE id = ?");

  const deleteTagsStmt = db.prepare("DELETE FROM artifact_tags WHERE artifactId = ?");

  const existsStmt = db.query<ExistsRow, [string]>("SELECT 1 AS found FROM artifacts WHERE id = ?");

  const updateArtifactStmt = db.prepare(`
    UPDATE artifacts
    SET name = $name, description = $description, content = $content,
        contentType = $contentType, contentHash = $contentHash,
        sizeBytes = $sizeBytes, metadata = $metadata, updatedAt = $updatedAt
    WHERE id = $id
  `);

  // -- Helpers --------------------------------------------------------------

  function loadTags(artifactIdVal: string): readonly string[] {
    const rows = selectTagsStmt.all(artifactIdVal);
    return rows.map((r) => r.tag);
  }

  function insertTags(artifactIdVal: string, tags: readonly string[]): void {
    for (const tag of tags) {
      insertTagStmt.run({ $artifactId: artifactIdVal, $tag: tag });
    }
  }

  /** Batch-load tags for multiple artifact IDs in a single query (avoids N+1). */
  function loadTagsBatch(ids: readonly string[]): ReadonlyMap<string, readonly string[]> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
      .query<TagWithIdRow, SQLQueryBindings[]>(
        `SELECT artifactId, tag FROM artifact_tags WHERE artifactId IN (${placeholders}) ORDER BY tag`,
      )
      .all(...ids);
    const result = new Map<string, string[]>();
    for (const row of rows) {
      const existing = result.get(row.artifactId);
      if (existing !== undefined) {
        existing.push(row.tag);
      } else {
        result.set(row.artifactId, [row.tag]);
      }
    }
    return result;
  }

  // -- ArtifactClient methods -----------------------------------------------

  const save = async (artifact: Artifact): Promise<Result<void, KoiError>> => {
    const idCheck = validateId(artifact.id);
    if (!idCheck.ok) return idCheck;

    try {
      db.transaction(() => {
        insertArtifactStmt.run({
          $id: artifact.id,
          $name: artifact.name,
          $description: artifact.description,
          $content: artifact.content,
          $contentType: artifact.contentType,
          $contentHash: artifact.contentHash ?? null,
          $sizeBytes: artifact.sizeBytes,
          $metadata: JSON.stringify(artifact.metadata),
          $createdBy: artifact.createdBy,
          $createdAt: artifact.createdAt,
          $updatedAt: artifact.updatedAt,
        });
        insertTags(artifact.id, artifact.tags);
      })();
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("UNIQUE constraint failed: artifacts.id")) {
        return { ok: false, error: conflictError(artifact.id) };
      }
      return { ok: false, error: internalError("Failed to save artifact", e) };
    }
  };

  const load = async (id: ArtifactId): Promise<Result<Artifact, KoiError>> => {
    const idCheck = validateId(id);
    if (!idCheck.ok) return idCheck;

    try {
      const row = selectArtifactStmt.get(id);
      if (row === null) {
        return { ok: false, error: notFoundError(id) };
      }
      const tags = loadTags(id);
      return { ok: true, value: rowToArtifact(row, tags) };
    } catch (e: unknown) {
      return { ok: false, error: internalError("Failed to load artifact", e) };
    }
  };

  const search = async (query: ArtifactQuery): Promise<Result<ArtifactPage, KoiError>> => {
    const queryCheck = validateQuery(query);
    if (!queryCheck.ok) return queryCheck;

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const sortBy = query.sortBy ?? "createdAt";
    const sortOrder = query.sortOrder ?? "desc";

    try {
      const where = buildSearchWhere(query);
      const sortCol = SORT_COLUMNS[sortBy] ?? "a.createdAt";
      const sortDir = sortOrder === "asc" ? "ASC" : "DESC";

      const countSql = `SELECT COUNT(*) AS count FROM artifacts a ${where.sql}`;
      const countRow = db.query<CountRow, SQLQueryBindings[]>(countSql).get(...where.params);
      const total = countRow?.count ?? 0;

      const selectSql = `SELECT a.* FROM artifacts a ${where.sql} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`;
      const rows = db
        .query<ArtifactRow, SQLQueryBindings[]>(selectSql)
        .all(...where.params, limit, offset);

      const tagMap = loadTagsBatch(rows.map((r) => r.id));
      const items = rows.map((row) => rowToArtifact(row, tagMap.get(row.id) ?? []));

      return { ok: true, value: { items, total, offset, limit } };
    } catch (e: unknown) {
      return { ok: false, error: internalError("Failed to search artifacts", e) };
    }
  };

  const remove = async (id: ArtifactId): Promise<Result<void, KoiError>> => {
    const idCheck = validateId(id);
    if (!idCheck.ok) return idCheck;

    try {
      const row = existsStmt.get(id);
      if (row === null) {
        return { ok: false, error: notFoundError(id) };
      }
      deleteArtifactStmt.run(id);
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return { ok: false, error: internalError("Failed to remove artifact", e) };
    }
  };

  const update = async (
    id: ArtifactId,
    updates: ArtifactUpdate,
  ): Promise<Result<void, KoiError>> => {
    const idCheck = validateId(id);
    if (!idCheck.ok) return idCheck;

    try {
      const row = selectArtifactStmt.get(id);
      if (row === null) {
        return { ok: false, error: notFoundError(id) };
      }

      const existingTags = loadTags(id);
      const existing = rowToArtifact(row, existingTags);

      const newContent = updates.content ?? existing.content;
      const contentChanged = updates.content !== undefined && updates.content !== existing.content;

      const newHash: ContentHash | undefined = contentChanged
        ? await computeContentHash(newContent)
        : existing.contentHash;
      const newSizeBytes = contentChanged
        ? new TextEncoder().encode(newContent).byteLength
        : existing.sizeBytes;

      db.transaction(() => {
        updateArtifactStmt.run({
          $id: id,
          $name: updates.name ?? existing.name,
          $description: updates.description ?? existing.description,
          $content: newContent,
          $contentType: updates.contentType ?? existing.contentType,
          $contentHash: newHash ?? null,
          $sizeBytes: newSizeBytes,
          $metadata: JSON.stringify(updates.metadata ?? existing.metadata),
          $updatedAt: Date.now(),
        });
        deleteTagsStmt.run(id);
        insertTags(id, updates.tags ?? existing.tags);
      })();

      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return { ok: false, error: internalError("Failed to update artifact", e) };
    }
  };

  const exists = async (id: ArtifactId): Promise<Result<boolean, KoiError>> => {
    const idCheck = validateId(id);
    if (!idCheck.ok) return idCheck;

    try {
      const row = existsStmt.get(id);
      return { ok: true, value: row !== null };
    } catch (e: unknown) {
      return { ok: false, error: internalError("Failed to check artifact existence", e) };
    }
  };

  const close = (): void => {
    db.close();
  };

  return { save, load, search, remove, update, exists, close };
}
