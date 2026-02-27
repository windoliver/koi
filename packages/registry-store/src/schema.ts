/**
 * Registry store schema — V1 DDL and migration runner.
 *
 * Creates tables for BrickRegistry, SkillRegistry, and VersionIndex.
 * Uses PRAGMA user_version for migration tracking. FTS5 tables use
 * contentless mode with manual sync from application code.
 */

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

const LATEST_VERSION = 1;

// ---------------------------------------------------------------------------
// V1 DDL
// ---------------------------------------------------------------------------

const V1_UP = `
-- ═══════════════════════════════════════════════════════
-- BRICK REGISTRY tables
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bricks (
  rowid        INTEGER PRIMARY KEY,
  brick_id     TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  scope        TEXT    NOT NULL,
  trust_tier   TEXT    NOT NULL,
  lifecycle    TEXT    NOT NULL,
  version      TEXT    NOT NULL,
  usage_count  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  data         TEXT    NOT NULL,
  UNIQUE (kind, name)
) STRICT;

CREATE TABLE IF NOT EXISTS brick_tags (
  brick_rowid  INTEGER NOT NULL REFERENCES bricks(rowid) ON DELETE CASCADE,
  tag          TEXT    NOT NULL,
  PRIMARY KEY (brick_rowid, tag)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_bricks_kind ON bricks(kind);
CREATE INDEX IF NOT EXISTS idx_bricks_cursor ON bricks(created_at DESC, rowid DESC);
CREATE INDEX IF NOT EXISTS idx_brick_tags_tag ON brick_tags(tag);

CREATE VIRTUAL TABLE IF NOT EXISTS bricks_fts USING fts5(
  name,
  description,
  tags,
  content     = '',
  tokenize    = 'unicode61 remove_diacritics 1'
);

-- ═══════════════════════════════════════════════════════
-- SKILL REGISTRY tables
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS skills (
  rowid        INTEGER PRIMARY KEY,
  skill_id     TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  author       TEXT,
  requires     TEXT,
  published_at INTEGER NOT NULL,
  downloads    INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS skill_tags (
  skill_rowid  INTEGER NOT NULL REFERENCES skills(rowid) ON DELETE CASCADE,
  tag          TEXT    NOT NULL,
  PRIMARY KEY (skill_rowid, tag)
) STRICT;

CREATE TABLE IF NOT EXISTS skill_versions (
  rowid        INTEGER PRIMARY KEY,
  skill_rowid  INTEGER NOT NULL REFERENCES skills(rowid) ON DELETE CASCADE,
  version      TEXT    NOT NULL,
  content      TEXT    NOT NULL,
  integrity    TEXT,
  published_at INTEGER NOT NULL,
  deprecated   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (skill_rowid, version)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_skills_cursor ON skills(published_at DESC, rowid DESC);
CREATE INDEX IF NOT EXISTS idx_skill_tags_tag ON skill_tags(tag);
CREATE INDEX IF NOT EXISTS idx_sv_skill_published ON skill_versions(skill_rowid, published_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  name,
  description,
  tags,
  content     = '',
  tokenize    = 'unicode61 remove_diacritics 1'
);

-- ═══════════════════════════════════════════════════════
-- VERSION INDEX tables
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS versions (
  rowid        INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  version      TEXT    NOT NULL,
  brick_id     TEXT    NOT NULL,
  publisher    TEXT    NOT NULL,
  published_at INTEGER NOT NULL,
  deprecated   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (name, kind, version)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_versions_lookup
  ON versions(name, kind, published_at DESC, rowid DESC);
`;

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/** Apply registry schema migrations. Idempotent — safe to call on every open. */
export function applyRegistryMigrations(db: Database): void {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const currentVersion = row?.user_version ?? 0;
  if (currentVersion >= LATEST_VERSION) return;

  db.transaction(() => {
    if (currentVersion < 1) {
      db.exec(V1_UP);
    }
    db.exec(`PRAGMA user_version = ${LATEST_VERSION}`);
  })();
}
