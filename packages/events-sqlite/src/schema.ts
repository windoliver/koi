/**
 * SQLite DDL and migration logic for the EventBackend schema.
 *
 * Uses PRAGMA user_version for schema versioning.
 * All tables use STRICT mode for type safety.
 */

import type { Database } from "bun:sqlite";

const LATEST_VERSION = 1;

const V1_UP = `
CREATE TABLE IF NOT EXISTS events (
  stream_id  TEXT    NOT NULL,
  sequence   INTEGER NOT NULL,
  id         TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  timestamp  INTEGER NOT NULL,
  data       TEXT    NOT NULL,
  metadata   TEXT,
  PRIMARY KEY (stream_id, sequence)
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_id ON events(id);

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_name TEXT PRIMARY KEY,
  stream_id         TEXT NOT NULL,
  position          INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS dead_letters (
  id                TEXT PRIMARY KEY,
  subscription_name TEXT NOT NULL,
  event_data        TEXT NOT NULL,
  error_message     TEXT NOT NULL,
  attempts          INTEGER NOT NULL,
  dead_lettered_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_dead_letters_sub
  ON dead_letters(subscription_name);
`;

interface UserVersionRow {
  readonly user_version: number;
}

/** Apply all pending migrations from current user_version to LATEST_VERSION. */
export function applyEventMigrations(db: Database): void {
  const row = db.query<UserVersionRow, []>("PRAGMA user_version").get();
  const currentVersion = row?.user_version ?? 0;

  if (currentVersion >= LATEST_VERSION) return;

  db.transaction(() => {
    if (currentVersion < 1) {
      db.exec(V1_UP);
    }
    db.exec(`PRAGMA user_version = ${String(LATEST_VERSION)}`);
  })();
}

export { LATEST_VERSION };
