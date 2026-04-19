import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemBlobStore } from "@koi/blob-cas";
import { sessionId } from "@koi/core";
import { createArtifactStore } from "../create-store.js";
import type { ArtifactStore } from "../types.js";

describe("startup recovery", () => {
  let blobDir: string;
  let dbPath: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    blobDir = join(tmpdir(), `koi-art-rec-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
    store = await createArtifactStore({ dbPath, blobDir });
  });

  afterEach(async () => {
    await store.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  async function simulateCrashedSave(hash: string, artifactBlobReady: 0 | 1): Promise<string> {
    await store.close();
    const db = new Database(dbPath);
    const now = Date.now();
    const artId = `art_${crypto.randomUUID()}`;
    db.exec(
      `INSERT INTO artifacts (id, session_id, name, version, mime_type, size, content_hash, created_at, blob_ready)
       VALUES ('${artId}', 'sess_a', 'crashed.txt', 1, 'text/plain', 3, '${hash}', ${now}, ${artifactBlobReady})`,
    );
    const intentId = `intent_${crypto.randomUUID()}`;
    db.exec(
      `INSERT INTO pending_blob_puts (intent_id, hash, created_at) VALUES ('${intentId}', '${hash}', ${now})`,
    );
    db.close();
    return artId;
  }

  test("promotes blob_ready=0 row when blob is present on disk", async () => {
    // Seed a real blob on disk
    const blobs = createFilesystemBlobStore(blobDir);
    const data = new TextEncoder().encode("abc");
    const hash = await blobs.put(data);
    const artId = await simulateCrashedSave(hash, 0);

    store = await createArtifactStore({ dbPath, blobDir });
    const r = await store.getArtifact(artId as never, {
      sessionId: sessionId("sess_a"),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(new TextDecoder().decode(r.value.data)).toBe("abc");
  });

  test("deletes blob_ready=0 row + tombstones hash when blob is missing", async () => {
    const fakeHash = "0".repeat(64);
    const artId = await simulateCrashedSave(fakeHash, 0);

    store = await createArtifactStore({ dbPath, blobDir });
    const r = await store.getArtifact(artId as never, {
      sessionId: sessionId("sess_a"),
    });
    expect(r.ok).toBe(false); // Row was deleted

    // Verify tombstone was enqueued
    await store.close();
    const db = new Database(dbPath);
    const tomb = db.query("SELECT 1 FROM pending_blob_deletes WHERE hash = ?").get(fakeHash);
    db.close();
    store = await createArtifactStore({ dbPath, blobDir });
    expect(tomb).toBeTruthy();
  });

  test("retires stale pending_blob_puts when matching blob_ready=1 row exists", async () => {
    const blobs = createFilesystemBlobStore(blobDir);
    const data = new TextEncoder().encode("ok");
    const hash = await blobs.put(data);
    await simulateCrashedSave(hash, 1); // blob_ready=1 but leaked intent

    store = await createArtifactStore({ dbPath, blobDir });
    // Intent should be gone after recovery
    await store.close();
    const db = new Database(dbPath);
    const count = db
      .query("SELECT COUNT(*) AS c FROM pending_blob_puts WHERE hash = ?")
      .get(hash) as { readonly c: number };
    db.close();
    store = await createArtifactStore({ dbPath, blobDir });
    expect(count.c).toBe(0);
  });
});

describe("close() mutation barrier", () => {
  let blobDir: string;
  let dbPath: string;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-art-close-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("after close, further calls throw 'closed'", async () => {
    const store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    await expect(
      store.saveArtifact({
        sessionId: sessionId("sess_a"),
        name: "x.txt",
        data: new TextEncoder().encode("x"),
        mimeType: "text/plain",
      }),
    ).rejects.toThrow(/closed/);
  });

  test("close is idempotent", async () => {
    const store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    await store.close();
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });
});
