/**
 * SQLite-backed ACE stores — persistent playbook and trajectory storage.
 *
 * Uses @koi/sqlite-utils openDb() for WAL mode and optimized PRAGMAs.
 * Schema uses junction tables with indexes for tag filtering (Decision 14A).
 */

import type { JsonObject } from "@koi/core/common";
import type { RichTrajectoryStep, RichTrajectoryStore } from "@koi/core/rich-trajectory";
import { openDb } from "@koi/sqlite-utils";
import type { PlaybookStore, StructuredPlaybookStore, TrajectoryStore } from "./stores.js";
import type { Playbook, StructuredPlaybook, TrajectoryEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 3;

function ensureSchema(db: ReturnType<typeof openDb>): void {
  const version = db.query("PRAGMA user_version").get() as { readonly user_version: number };
  if (version.user_version >= SCHEMA_VERSION) return;

  // Note: all CREATE TABLE use IF NOT EXISTS, so re-running on v1 databases
  // only creates the new rich_trajectories table and bumps the version.

  db.run(`
    CREATE TABLE IF NOT EXISTS trajectories (
      session_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      timestamp  INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      identifier TEXT NOT NULL,
      outcome    TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      metadata   TEXT,
      bullet_ids TEXT,
      PRIMARY KEY (session_id, turn_index, identifier)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS playbooks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      strategy      TEXT NOT NULL,
      confidence    REAL NOT NULL,
      source        TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      session_count INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS playbook_tags (
      playbook_id TEXT NOT NULL,
      tag         TEXT NOT NULL,
      PRIMARY KEY (playbook_id, tag),
      FOREIGN KEY (playbook_id) REFERENCES playbooks(id) ON DELETE CASCADE
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_playbook_tags_tag ON playbook_tags(tag)");
  db.run("CREATE INDEX IF NOT EXISTS idx_playbooks_confidence ON playbooks(confidence)");

  db.run(`
    CREATE TABLE IF NOT EXISTS structured_playbooks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      sections      TEXT NOT NULL,
      source        TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      session_count INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS structured_playbook_tags (
      playbook_id TEXT NOT NULL,
      tag         TEXT NOT NULL,
      PRIMARY KEY (playbook_id, tag),
      FOREIGN KEY (playbook_id) REFERENCES structured_playbooks(id) ON DELETE CASCADE
    )
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_structured_playbook_tags_tag ON structured_playbook_tags(tag)",
  );

  // Rich trajectory store (v2)
  db.run(`
    CREATE TABLE IF NOT EXISTS rich_trajectories (
      session_id  TEXT NOT NULL,
      step_index  INTEGER NOT NULL,
      timestamp   INTEGER NOT NULL,
      step_data   TEXT NOT NULL,
      PRIMARY KEY (session_id, step_index)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_rich_trajectories_ts ON rich_trajectories(timestamp)");

  // v3: add watermark column to structured_playbooks
  // ALTER TABLE ADD COLUMN is safe to re-run — fails silently if column exists
  try {
    db.run("ALTER TABLE structured_playbooks ADD COLUMN last_reflected_step_index INTEGER");
  } catch {
    // Column already exists — ignore
  }

  db.run(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`);
}

// ---------------------------------------------------------------------------
// SQLite TrajectoryStore
// ---------------------------------------------------------------------------

export interface SqliteTrajectoryStoreConfig {
  /** Path to the SQLite database file. */
  readonly dbPath: string;
}

/** Creates a SQLite-backed TrajectoryStore for persistent trajectory storage. */
export function createSqliteTrajectoryStore(config: SqliteTrajectoryStoreConfig): TrajectoryStore {
  const db = openDb(config.dbPath);
  ensureSchema(db);

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO trajectories
      (session_id, turn_index, timestamp, kind, identifier, outcome, duration_ms, metadata, bullet_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    async append(sessionId: string, entries: readonly TrajectoryEntry[]): Promise<void> {
      const insert = db.transaction(() => {
        for (const e of entries) {
          insertStmt.run(
            sessionId,
            e.turnIndex,
            e.timestamp,
            e.kind,
            e.identifier,
            e.outcome,
            e.durationMs,
            e.metadata !== undefined ? JSON.stringify(e.metadata) : null,
            e.bulletIds !== undefined ? JSON.stringify(e.bulletIds) : null,
          );
        }
      });
      insert();
    },

    async getSession(sessionId: string): Promise<readonly TrajectoryEntry[]> {
      const rows = db
        .query("SELECT * FROM trajectories WHERE session_id = ? ORDER BY turn_index, identifier")
        .all(sessionId) as readonly TrajectoryRow[];
      return rows.map(rowToTrajectoryEntry);
    },

    async listSessions(options?: {
      readonly limit?: number;
      readonly before?: number;
    }): Promise<readonly string[]> {
      const limit = options?.limit ?? 100;
      const rows = db
        .query("SELECT DISTINCT session_id FROM trajectories ORDER BY ROWID DESC LIMIT ?")
        .all(limit) as readonly { readonly session_id: string }[];
      return rows.map((r) => r.session_id);
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite PlaybookStore
// ---------------------------------------------------------------------------

export interface SqlitePlaybookStoreConfig {
  /** Path to the SQLite database file. */
  readonly dbPath: string;
}

/** Creates a SQLite-backed PlaybookStore for persistent playbook storage. */
export function createSqlitePlaybookStore(config: SqlitePlaybookStoreConfig): PlaybookStore {
  const db = openDb(config.dbPath);
  ensureSchema(db);

  return {
    async get(id: string): Promise<Playbook | undefined> {
      const row = db.query("SELECT * FROM playbooks WHERE id = ?").get(id) as PlaybookRow | null;
      if (row === null) return undefined;
      const tags = db
        .query("SELECT tag FROM playbook_tags WHERE playbook_id = ?")
        .all(id) as readonly { readonly tag: string }[];
      return rowToPlaybook(
        row,
        tags.map((t) => t.tag),
      );
    },

    async list(options?: {
      readonly tags?: readonly string[];
      readonly minConfidence?: number;
    }): Promise<readonly Playbook[]> {
      const hasMinConfidence = options?.minConfidence !== undefined;
      const query = hasMinConfidence
        ? "SELECT * FROM playbooks WHERE confidence >= ?"
        : "SELECT * FROM playbooks";

      const rows = (
        hasMinConfidence ? db.query(query).all(options.minConfidence) : db.query(query).all()
      ) as readonly PlaybookRow[];

      // If tag filtering requested, filter via junction table
      const tagFilter = options?.tags;
      const results: Playbook[] = [];
      for (const row of rows) {
        const tags = db
          .query("SELECT tag FROM playbook_tags WHERE playbook_id = ?")
          .all(row.id) as readonly { readonly tag: string }[];
        const tagStrings = tags.map((t) => t.tag);

        if (tagFilter !== undefined && tagFilter.length > 0) {
          if (!tagFilter.some((t) => tagStrings.includes(t))) continue;
        }

        results.push(rowToPlaybook(row, tagStrings));
      }
      return results;
    },

    async save(playbook: Playbook): Promise<void> {
      const upsert = db.transaction(() => {
        db.run(
          `INSERT OR REPLACE INTO playbooks
            (id, title, strategy, confidence, source, created_at, updated_at, session_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            playbook.id,
            playbook.title,
            playbook.strategy,
            playbook.confidence,
            playbook.source,
            playbook.createdAt,
            playbook.updatedAt,
            playbook.sessionCount,
          ],
        );
        db.run("DELETE FROM playbook_tags WHERE playbook_id = ?", [playbook.id]);
        const insertTag = db.prepare("INSERT INTO playbook_tags (playbook_id, tag) VALUES (?, ?)");
        for (const tag of playbook.tags) {
          insertTag.run(playbook.id, tag);
        }
      });
      upsert();
    },

    async remove(id: string): Promise<boolean> {
      // CASCADE deletes tags automatically
      const result = db.run("DELETE FROM playbooks WHERE id = ?", [id]);
      return result.changes > 0;
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite StructuredPlaybookStore
// ---------------------------------------------------------------------------

export interface SqliteStructuredPlaybookStoreConfig {
  /** Path to the SQLite database file. */
  readonly dbPath: string;
}

/** Creates a SQLite-backed StructuredPlaybookStore for persistent storage. */
export function createSqliteStructuredPlaybookStore(
  config: SqliteStructuredPlaybookStoreConfig,
): StructuredPlaybookStore {
  const db = openDb(config.dbPath);
  ensureSchema(db);

  return {
    async get(id: string): Promise<StructuredPlaybook | undefined> {
      const row = db
        .query("SELECT * FROM structured_playbooks WHERE id = ?")
        .get(id) as StructuredPlaybookRow | null;
      if (row === null) return undefined;
      const tags = db
        .query("SELECT tag FROM structured_playbook_tags WHERE playbook_id = ?")
        .all(id) as readonly { readonly tag: string }[];
      return rowToStructuredPlaybook(
        row,
        tags.map((t) => t.tag),
      );
    },

    async list(options?: {
      readonly tags?: readonly string[];
    }): Promise<readonly StructuredPlaybook[]> {
      const rows = db
        .query("SELECT * FROM structured_playbooks")
        .all() as readonly StructuredPlaybookRow[];

      const tagFilter = options?.tags;
      const results: StructuredPlaybook[] = [];
      for (const row of rows) {
        const tags = db
          .query("SELECT tag FROM structured_playbook_tags WHERE playbook_id = ?")
          .all(row.id) as readonly { readonly tag: string }[];
        const tagStrings = tags.map((t) => t.tag);

        if (tagFilter !== undefined && tagFilter.length > 0) {
          if (!tagFilter.some((t) => tagStrings.includes(t))) continue;
        }

        results.push(rowToStructuredPlaybook(row, tagStrings));
      }
      return results;
    },

    async save(playbook: StructuredPlaybook): Promise<void> {
      const upsert = db.transaction(() => {
        db.run(
          `INSERT OR REPLACE INTO structured_playbooks
            (id, title, sections, source, created_at, updated_at, session_count, last_reflected_step_index)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            playbook.id,
            playbook.title,
            JSON.stringify(playbook.sections),
            playbook.source,
            playbook.createdAt,
            playbook.updatedAt,
            playbook.sessionCount,
            playbook.lastReflectedStepIndex ?? null,
          ],
        );
        db.run("DELETE FROM structured_playbook_tags WHERE playbook_id = ?", [playbook.id]);
        const insertTag = db.prepare(
          "INSERT INTO structured_playbook_tags (playbook_id, tag) VALUES (?, ?)",
        );
        for (const tag of playbook.tags) {
          insertTag.run(playbook.id, tag);
        }
      });
      upsert();
    },

    async remove(id: string): Promise<boolean> {
      const result = db.run("DELETE FROM structured_playbooks WHERE id = ?", [id]);
      return result.changes > 0;
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite RichTrajectoryStore
// ---------------------------------------------------------------------------

export interface SqliteRichTrajectoryStoreConfig {
  /** Path to the SQLite database file. */
  readonly dbPath: string;
}

/** Creates a SQLite-backed RichTrajectoryStore for persistent rich trajectory storage. */
export function createSqliteRichTrajectoryStore(
  config: SqliteRichTrajectoryStoreConfig,
): RichTrajectoryStore {
  const db = openDb(config.dbPath);
  ensureSchema(db);

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO rich_trajectories
      (session_id, step_index, timestamp, step_data)
    VALUES (?, ?, ?, ?)
  `);

  return {
    async append(sessionId: string, steps: readonly RichTrajectoryStep[]): Promise<void> {
      const insert = db.transaction(() => {
        for (const step of steps) {
          insertStmt.run(sessionId, step.stepIndex, step.timestamp, JSON.stringify(step));
        }
      });
      insert();
    },

    async getSession(sessionId: string): Promise<readonly RichTrajectoryStep[]> {
      const rows = db
        .query("SELECT step_data FROM rich_trajectories WHERE session_id = ? ORDER BY step_index")
        .all(sessionId) as readonly { readonly step_data: string }[];
      return rows.map((r) => JSON.parse(r.step_data) as RichTrajectoryStep);
    },

    async prune(olderThanMs: number): Promise<number> {
      const result = db.run("DELETE FROM rich_trajectories WHERE timestamp < ?", [olderThanMs]);
      return result.changes;
    },
  };
}

// ---------------------------------------------------------------------------
// Row types + mappers
// ---------------------------------------------------------------------------

interface TrajectoryRow {
  readonly session_id: string;
  readonly turn_index: number;
  readonly timestamp: number;
  readonly kind: string;
  readonly identifier: string;
  readonly outcome: string;
  readonly duration_ms: number;
  readonly metadata: string | null;
  readonly bullet_ids: string | null;
}

interface PlaybookRow {
  readonly id: string;
  readonly title: string;
  readonly strategy: string;
  readonly confidence: number;
  readonly source: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly session_count: number;
}

interface StructuredPlaybookRow {
  readonly id: string;
  readonly title: string;
  readonly sections: string;
  readonly source: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly session_count: number;
  readonly last_reflected_step_index: number | null;
}

function rowToTrajectoryEntry(row: TrajectoryRow): TrajectoryEntry {
  const base = {
    turnIndex: row.turn_index,
    timestamp: row.timestamp,
    kind: row.kind as TrajectoryEntry["kind"],
    identifier: row.identifier,
    outcome: row.outcome as TrajectoryEntry["outcome"],
    durationMs: row.duration_ms,
  };

  // exactOptionalPropertyTypes: omit optional fields entirely when null
  if (row.metadata !== null && row.bullet_ids !== null) {
    return {
      ...base,
      metadata: JSON.parse(row.metadata) as JsonObject,
      bulletIds: JSON.parse(row.bullet_ids) as readonly string[],
    };
  }
  if (row.metadata !== null) {
    return { ...base, metadata: JSON.parse(row.metadata) as JsonObject };
  }
  if (row.bullet_ids !== null) {
    return { ...base, bulletIds: JSON.parse(row.bullet_ids) as readonly string[] };
  }
  return base;
}

function rowToPlaybook(row: PlaybookRow, tags: readonly string[]): Playbook {
  return {
    id: row.id,
    title: row.title,
    strategy: row.strategy,
    tags,
    confidence: row.confidence,
    source: row.source as Playbook["source"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sessionCount: row.session_count,
  };
}

function rowToStructuredPlaybook(
  row: StructuredPlaybookRow,
  tags: readonly string[],
): StructuredPlaybook {
  return {
    id: row.id,
    title: row.title,
    sections: JSON.parse(row.sections) as StructuredPlaybook["sections"],
    tags,
    source: row.source as StructuredPlaybook["source"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sessionCount: row.session_count,
    ...(row.last_reflected_step_index !== null
      ? { lastReflectedStepIndex: row.last_reflected_step_index }
      : {}),
  };
}
