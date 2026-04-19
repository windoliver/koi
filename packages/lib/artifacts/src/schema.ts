/**
 * SQL DDL for the artifacts store. Applied verbatim at open time via
 * `applySchema(db)` in sqlite.ts. Every table, every index, no surprises.
 *
 * See docs/superpowers/specs/2026-04-18-artifacts-design.md §5 for rationale.
 */

export const DDL_ARTIFACTS = `
CREATE TABLE IF NOT EXISTS artifacts (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  version         INTEGER NOT NULL,
  mime_type       TEXT NOT NULL,
  size            INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  tags            TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,
  blob_ready      INTEGER NOT NULL DEFAULT 1,
  repair_attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, name, version)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_name    ON artifacts(session_id, name);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_hash    ON artifacts(content_hash);
` as const;

export const DDL_ARTIFACT_SHARES = `
CREATE TABLE IF NOT EXISTS artifact_shares (
  artifact_id           TEXT NOT NULL,
  granted_to_session_id TEXT NOT NULL,
  granted_at            INTEGER NOT NULL,
  PRIMARY KEY(artifact_id, granted_to_session_id),
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shares_grantee ON artifact_shares(granted_to_session_id);
` as const;

export const DDL_PENDING_BLOB_DELETES = `
CREATE TABLE IF NOT EXISTS pending_blob_deletes (
  hash        TEXT PRIMARY KEY,
  enqueued_at INTEGER NOT NULL,
  claimed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pending_enqueued ON pending_blob_deletes(enqueued_at);
` as const;

export const DDL_PENDING_BLOB_PUTS = `
CREATE TABLE IF NOT EXISTS pending_blob_puts (
  intent_id   TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  artifact_id TEXT,                -- the specific row this intent covers;
                                    -- NULL when the save crashed before its
                                    -- metadata INSERT committed. Recovery
                                    -- uses this to target the exact hidden
                                    -- row rather than matching by hash
                                    -- (which would collapse under concurrent
                                    -- same-content saves — spec §6.1).
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_puts_hash        ON pending_blob_puts(hash);
CREATE INDEX IF NOT EXISTS idx_pending_puts_created     ON pending_blob_puts(created_at);
CREATE INDEX IF NOT EXISTS idx_pending_puts_artifact_id ON pending_blob_puts(artifact_id);
` as const;

export const DDL_META = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
` as const;

export const ALL_DDL: ReadonlyArray<string> = [
  DDL_ARTIFACTS,
  DDL_ARTIFACT_SHARES,
  DDL_PENDING_BLOB_DELETES,
  DDL_PENDING_BLOB_PUTS,
  DDL_META,
];
