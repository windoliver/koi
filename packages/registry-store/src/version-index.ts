/**
 * SQLite-backed VersionIndex implementation.
 *
 * Stores version entries with publisher tracking. Yank = hard DELETE,
 * deprecate = soft flag. Keyset cursor on (published_at DESC, rowid DESC).
 */

import type {
  BrickId,
  BrickKind,
  KoiError,
  PublisherId,
  Result,
  VersionChangeEvent,
  VersionEntry,
  VersionIndexBackend,
} from "@koi/core";
import { conflict, notFound, validation } from "@koi/core";
import { wrapSqlite } from "@koi/sqlite-utils";
import type { RegistryStoreConfig } from "./config.js";
import { resolveDb } from "./config.js";
import { createListenerSet } from "./listeners.js";
import { applyRegistryMigrations } from "./schema.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface VersionRow {
  readonly rowid: number;
  readonly name: string;
  readonly kind: string;
  readonly version: string;
  readonly brick_id: string;
  readonly publisher: string;
  readonly published_at: number;
  readonly deprecated: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface SqliteVersionIndex extends VersionIndexBackend {
  readonly close: () => void;
}

export function createSqliteVersionIndex(config: RegistryStoreConfig): SqliteVersionIndex {
  const { db, ownsDb } = resolveDb(config);
  applyRegistryMigrations(db);

  const listeners = createListenerSet<VersionChangeEvent>();

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function toEntry(row: VersionRow): VersionEntry {
    const entry: VersionEntry = {
      version: row.version,
      brickId: row.brick_id as BrickId,
      publisher: row.publisher as PublisherId,
      publishedAt: row.published_at,
    };
    return row.deprecated === 1 ? { ...entry, deprecated: true } : entry;
  }

  function isBlank(s: string): boolean {
    return s.trim() === "";
  }

  // -------------------------------------------------------------------------
  // Contract: publish
  // -------------------------------------------------------------------------

  const publish = (
    name: string,
    kind: BrickKind,
    version: string,
    brickId: BrickId,
    publisher: PublisherId,
  ): Result<VersionEntry, KoiError> => {
    if (isBlank(name)) {
      return { ok: false, error: validation("name must not be empty") };
    }
    if (isBlank(version)) {
      return { ok: false, error: validation("version must not be empty") };
    }

    // Check for existing version
    const existing = db
      .query<VersionRow, [string, string, string]>(
        "SELECT * FROM versions WHERE name = ? AND kind = ? AND version = ?",
      )
      .get(name, kind, version);

    if (existing !== null) {
      // Idempotent if same brickId
      if (existing.brick_id === (brickId as string)) {
        return { ok: true, value: toEntry(existing) };
      }
      return {
        ok: false,
        error: conflict(
          `${kind}:${name}@${version}`,
          `Version ${version} of ${kind}:${name} already maps to brick ${existing.brick_id}`,
        ),
      };
    }

    const now = Date.now();
    const result = wrapSqlite(() => {
      db.run(
        `INSERT INTO versions (name, kind, version, brick_id, publisher, published_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [name, kind, version, brickId as string, publisher as string, now],
      );
    }, "version.publish");

    if (!result.ok) return result;

    const entry: VersionEntry = {
      version,
      brickId,
      publisher,
      publishedAt: now,
    };

    listeners.notify({
      kind: "published",
      brickKind: kind,
      name,
      version,
      brickId,
      publisher,
    });

    return { ok: true, value: entry };
  };

  // -------------------------------------------------------------------------
  // Contract: resolve
  // -------------------------------------------------------------------------

  const resolve = (
    name: string,
    kind: BrickKind,
    version: string,
  ): Result<VersionEntry, KoiError> => {
    const row = db
      .query<VersionRow, [string, string, string]>(
        "SELECT * FROM versions WHERE name = ? AND kind = ? AND version = ?",
      )
      .get(name, kind, version);

    if (row === null) {
      return { ok: false, error: notFound(`${kind}:${name}@${version}`) };
    }
    return { ok: true, value: toEntry(row) };
  };

  // -------------------------------------------------------------------------
  // Contract: resolveLatest
  // -------------------------------------------------------------------------

  const resolveLatest = (name: string, kind: BrickKind): Result<VersionEntry, KoiError> => {
    const row = db
      .query<VersionRow, [string, string]>(
        `SELECT * FROM versions
         WHERE name = ? AND kind = ?
         ORDER BY published_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(name, kind);

    if (row === null) {
      return { ok: false, error: notFound(`${kind}:${name}`) };
    }
    return { ok: true, value: toEntry(row) };
  };

  // -------------------------------------------------------------------------
  // Contract: listVersions
  // -------------------------------------------------------------------------

  const listVersions = (
    name: string,
    kind: BrickKind,
  ): Result<readonly VersionEntry[], KoiError> => {
    const rows = db
      .query<VersionRow, [string, string]>(
        `SELECT * FROM versions
         WHERE name = ? AND kind = ?
         ORDER BY published_at DESC, rowid DESC`,
      )
      .all(name, kind);

    if (rows.length === 0) {
      return { ok: false, error: notFound(`${kind}:${name}`) };
    }
    return { ok: true, value: rows.map(toEntry) };
  };

  // -------------------------------------------------------------------------
  // Contract: deprecate
  // -------------------------------------------------------------------------

  const deprecate = (name: string, kind: BrickKind, version: string): Result<void, KoiError> => {
    const existing = db
      .query<VersionRow, [string, string, string]>(
        "SELECT * FROM versions WHERE name = ? AND kind = ? AND version = ?",
      )
      .get(name, kind, version);

    if (existing === null) {
      return { ok: false, error: notFound(`${kind}:${name}@${version}`) };
    }

    // Idempotent
    if (existing.deprecated === 0) {
      const result = wrapSqlite(() => {
        db.run("UPDATE versions SET deprecated = 1 WHERE name = ? AND kind = ? AND version = ?", [
          name,
          kind,
          version,
        ]);
      }, "version.deprecate");

      if (!result.ok) return result;

      listeners.notify({
        kind: "deprecated",
        brickKind: kind,
        name,
        version,
        brickId: existing.brick_id as BrickId,
        publisher: existing.publisher as PublisherId,
      });
    }

    return { ok: true, value: undefined };
  };

  // -------------------------------------------------------------------------
  // Contract: yank
  // -------------------------------------------------------------------------

  const yank = (name: string, kind: BrickKind, version: string): Result<void, KoiError> => {
    const existing = db
      .query<VersionRow, [string, string, string]>(
        "SELECT * FROM versions WHERE name = ? AND kind = ? AND version = ?",
      )
      .get(name, kind, version);

    if (existing === null) {
      return { ok: false, error: notFound(`${kind}:${name}@${version}`) };
    }

    const result = wrapSqlite(() => {
      db.run("DELETE FROM versions WHERE name = ? AND kind = ? AND version = ?", [
        name,
        kind,
        version,
      ]);
    }, "version.yank");

    if (!result.ok) return result;

    listeners.notify({
      kind: "yanked",
      brickKind: kind,
      name,
      version,
      brickId: existing.brick_id as BrickId,
      publisher: existing.publisher as PublisherId,
    });

    return { ok: true, value: undefined };
  };

  // -------------------------------------------------------------------------
  // Contract: onChange
  // -------------------------------------------------------------------------

  const onChange = (listener: (event: VersionChangeEvent) => void): (() => void) => {
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

  return { publish, resolve, resolveLatest, listVersions, deprecate, yank, onChange, close };
}
