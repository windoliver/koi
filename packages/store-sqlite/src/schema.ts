/**
 * SQLite DDL and migration logic for the ForgeStore schema.
 *
 * Uses PRAGMA user_version for schema versioning.
 * All tables use STRICT mode for type safety.
 */

import type { Database } from "bun:sqlite";

const LATEST_VERSION = 1;

const V1_UP = `
CREATE TABLE IF NOT EXISTS bricks (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  name         TEXT NOT NULL,
  scope        TEXT NOT NULL,
  trust_tier   TEXT NOT NULL,
  lifecycle    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  usage_count  INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  version      TEXT NOT NULL,
  description  TEXT NOT NULL,
  data         TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS brick_tags (
  brick_id TEXT NOT NULL REFERENCES bricks(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (brick_id, tag)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_bricks_kind_scope ON bricks(kind, scope, lifecycle);
CREATE INDEX IF NOT EXISTS idx_brick_tags_tag ON brick_tags(tag);
`;

interface UserVersionRow {
  readonly user_version: number;
}

/** Apply all pending migrations from current user_version to LATEST_VERSION. */
export function applyMigrations(db: Database): void {
  const row = db.query<UserVersionRow, []>("PRAGMA user_version").get();
  const currentVersion = row?.user_version ?? 0;

  if (currentVersion >= LATEST_VERSION) return;

  db.transaction(() => {
    if (currentVersion < 1) {
      db.exec(V1_UP);
    }
    // Future migrations: if (currentVersion < 2) { ... }
    db.exec(`PRAGMA user_version = ${LATEST_VERSION}`);
  })();
}

export { LATEST_VERSION };
