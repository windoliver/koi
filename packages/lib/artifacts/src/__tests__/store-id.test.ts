import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemBlobStore } from "@koi/blob-cas";
import { openDatabase } from "../sqlite.js";
import { ensureStoreIdPair, readStoreIdFromDb } from "../store-id.js";

describe("store-id fingerprint", () => {
  let blobDir: string;
  let db: Database;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-art-storeid-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    db = openDatabase({ dbPath: ":memory:" });
  });

  afterEach(() => {
    db.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("both missing + empty → bootstraps fresh UUID on both sides", async () => {
    const blobStore = createFilesystemBlobStore(blobDir);
    const id = await ensureStoreIdPair({ db, blobDir, blobStore });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const dbId = readStoreIdFromDb(db);
    expect(dbId).toBe(id);
    const sentinel = readFileSync(join(blobDir, ".store-id"), "utf8").trim();
    expect(sentinel).toBe(id);
  });

  test("both present + match → opens normally", async () => {
    const blobStore = createFilesystemBlobStore(blobDir);
    const id1 = await ensureStoreIdPair({ db, blobDir, blobStore });
    const id2 = await ensureStoreIdPair({ db, blobDir, blobStore });
    expect(id1).toBe(id2);
  });

  test("both present + differ → throws 'paired with a different ArtifactStore'", async () => {
    const blobStore = createFilesystemBlobStore(blobDir);
    await ensureStoreIdPair({ db, blobDir, blobStore });
    writeFileSync(join(blobDir, ".store-id"), "different-uuid");
    await expect(ensureStoreIdPair({ db, blobDir, blobStore })).rejects.toThrow(
      /paired with a different ArtifactStore/,
    );
  });

  test("DB present + sentinel missing → throws 'missing store-id sentinel'", async () => {
    const blobStore = createFilesystemBlobStore(blobDir);
    await ensureStoreIdPair({ db, blobDir, blobStore });
    rmSync(join(blobDir, ".store-id"));
    await expect(ensureStoreIdPair({ db, blobDir, blobStore })).rejects.toThrow(
      /missing store-id sentinel/,
    );
  });

  test("sentinel present + DB missing → throws 'metadata DB is missing store-id'", async () => {
    writeFileSync(join(blobDir, ".store-id"), crypto.randomUUID());
    const blobStore = createFilesystemBlobStore(blobDir);
    await expect(ensureStoreIdPair({ db, blobDir, blobStore })).rejects.toThrow(
      /Metadata DB is missing store-id/,
    );
  });

  test("both missing + DB has existing rows → throws 'missing on a non-empty store'", async () => {
    db.exec(
      "INSERT INTO artifacts (id, session_id, name, version, mime_type, size, content_hash, created_at) VALUES ('art_1', 'sess_a', 'n', 1, 'text/plain', 5, 'deadbeef', 0)",
    );
    const blobStore = createFilesystemBlobStore(blobDir);
    await expect(ensureStoreIdPair({ db, blobDir, blobStore })).rejects.toThrow(
      /missing on a non-empty store/,
    );
  });
});
