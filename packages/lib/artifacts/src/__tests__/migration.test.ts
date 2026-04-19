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

  test("adds artifact_id to pre-existing pending_blob_puts table", async () => {
    // Seed a DB with the OLD pending_blob_puts schema (no artifact_id column).
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
      CREATE TABLE pending_blob_deletes (
        hash TEXT PRIMARY KEY, enqueued_at INTEGER NOT NULL, claimed_at INTEGER
      );
      -- OLD schema: no artifact_id column
      CREATE TABLE pending_blob_puts (
        intent_id TEXT PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('store_id', '12345678-1234-1234-1234-123456789abc');
    `);
    db.close();

    // Seed the store-id sentinel on FS so pairing passes.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(blobDir, ".store-id"), "12345678-1234-1234-1234-123456789abc");

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
});
