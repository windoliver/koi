import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactStore } from "../create-store.js";

describe("schema migration", () => {
  let blobDir: string;
  let dbPath: string;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-art-mig-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  /**
   * Seed a Plan-2 DB at `dbPath` with the pre-Plan-3 schema:
   *   - pending_blob_puts WITHOUT artifact_id (Plan 2 pre-fix-round-2)
   *   - pending_blob_deletes WITHOUT claimed_at (Plan 2 canonical)
   */
  function seedPlan2Db(): void {
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL,
        version INTEGER NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
        content_hash TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL, expires_at INTEGER,
        blob_ready INTEGER NOT NULL DEFAULT 1,
        repair_attempts INTEGER NOT NULL DEFAULT 0,
        UNIQUE(session_id, name, version)
      );
      CREATE TABLE artifact_shares (
        artifact_id TEXT NOT NULL, granted_to_session_id TEXT NOT NULL,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY(artifact_id, granted_to_session_id),
        FOREIGN KEY(artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
      );
      -- OLD schema: no claimed_at column
      CREATE TABLE pending_blob_deletes (
        hash TEXT PRIMARY KEY, enqueued_at INTEGER NOT NULL
      );
      -- OLD schema: no artifact_id column
      CREATE TABLE pending_blob_puts (
        intent_id TEXT PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('store_id', '12345678-1234-1234-1234-123456789abc');
    `);
    db.close();
  }

  async function seedStoreIdSentinel(): Promise<void> {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(blobDir, ".store-id"), "12345678-1234-1234-1234-123456789abc");
  }

  test("adds artifact_id to pre-existing pending_blob_puts table", async () => {
    seedPlan2Db();
    await seedStoreIdSentinel();

    // Open with the new code — migration must add the column and open must succeed.
    const store = await createArtifactStore({ dbPath, blobDir });
    await store.close();

    // Verify the column is present.
    const db2 = new Database(dbPath);
    const info = db2.query("PRAGMA table_info(pending_blob_puts)").all() as ReadonlyArray<{
      readonly name: string;
    }>;
    db2.close();
    const columns = info.map((r) => r.name);
    expect(columns).toContain("intent_id");
    expect(columns).toContain("hash");
    expect(columns).toContain("created_at");
    expect(columns).toContain("artifact_id");
  });

  test("adds claimed_at to pre-existing pending_blob_deletes table (Plan 3)", async () => {
    seedPlan2Db();
    await seedStoreIdSentinel();

    // Open with the new code — migration must add the column and open must succeed.
    const store = await createArtifactStore({ dbPath, blobDir });
    await store.close();

    const db2 = new Database(dbPath);
    const info = db2.query("PRAGMA table_info(pending_blob_deletes)").all() as ReadonlyArray<{
      readonly name: string;
      readonly type: string;
      readonly notnull: number;
      readonly dflt_value: string | null;
    }>;
    db2.close();
    const claimedAt = info.find((r) => r.name === "claimed_at");
    expect(claimedAt).toBeDefined();
    expect(claimedAt?.type).toBe("INTEGER");
    expect(claimedAt?.notnull).toBe(0);
    expect(claimedAt?.dflt_value).toBeNull();
  });

  test("claimed_at migration preserves existing Plan-2 rows with NULL", async () => {
    seedPlan2Db();

    // Insert a pre-existing tombstone row the way Plan 2 runtime would have.
    const seedDb = new Database(dbPath);
    seedDb.exec("INSERT INTO pending_blob_deletes (hash, enqueued_at) VALUES ('deadbeef', 1234)");
    seedDb.close();

    await seedStoreIdSentinel();

    const store = await createArtifactStore({ dbPath, blobDir });
    await store.close();

    const db2 = new Database(dbPath);
    const row = db2
      .query(
        "SELECT hash, enqueued_at, claimed_at FROM pending_blob_deletes WHERE hash = 'deadbeef'",
      )
      .get() as {
      readonly hash: string;
      readonly enqueued_at: number;
      readonly claimed_at: number | null;
    };
    db2.close();
    expect(row.hash).toBe("deadbeef");
    expect(row.enqueued_at).toBe(1234);
    // Migrated rows have NULL claimed_at — unclaimed by definition.
    expect(row.claimed_at).toBeNull();
  });

  test("claimed_at migration is idempotent — running twice does not throw", async () => {
    seedPlan2Db();
    await seedStoreIdSentinel();

    // First open runs the migration.
    const store1 = await createArtifactStore({ dbPath, blobDir });
    await store1.close();

    // Second open must re-run openDatabase without re-adding the column.
    const store2 = await createArtifactStore({ dbPath, blobDir });
    await store2.close();

    const db2 = new Database(dbPath);
    const info = db2.query("PRAGMA table_info(pending_blob_deletes)").all() as ReadonlyArray<{
      readonly name: string;
    }>;
    db2.close();
    // Column appears exactly once — PRAGMA returns one row per column.
    const matches = info.filter((r) => r.name === "claimed_at");
    expect(matches.length).toBe(1);
  });
});
