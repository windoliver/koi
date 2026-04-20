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
    db.query(
      `INSERT INTO artifacts (id, session_id, name, version, mime_type, size, content_hash, created_at, blob_ready)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(artId, "sess_a", "crashed.txt", 1, "text/plain", 3, hash, now, artifactBlobReady);
    // Simulate a mid-save crash: the intent is bound to this specific artifact_id
    // (post-save.ts's UPDATE pending_blob_puts SET artifact_id = ?).
    const intentId = `intent_${crypto.randomUUID()}`;
    db.query(
      `INSERT INTO pending_blob_puts (intent_id, hash, artifact_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(intentId, hash, artId, now);
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

  test("does NOT delete blob_ready=0 row on first missing-blob probe (retry budget)", async () => {
    // Transient backend outage on restart: single negative has() must not
    // reap a committed save. Row stays blob_ready=0 with repair_attempts
    // incremented for the next pass.
    const fakeHash = "0".repeat(64);
    const artId = await simulateCrashedSave(fakeHash, 0);

    store = await createArtifactStore({ dbPath, blobDir, maxRepairAttempts: 10 });
    const r = await store.getArtifact(artId as never, {
      sessionId: sessionId("sess_a"),
    });
    // Row is invisible (blob_ready=0) but not deleted
    expect(r.ok).toBe(false);

    await store.close();
    const db = new Database(dbPath);
    const row = db.query("SELECT repair_attempts FROM artifacts WHERE id = ?").get(artId) as {
      readonly repair_attempts: number;
    } | null;
    const tomb = db.query("SELECT 1 FROM pending_blob_deletes WHERE hash = ?").get(fakeHash);
    db.close();
    store = await createArtifactStore({ dbPath, blobDir, maxRepairAttempts: 10 });
    expect(row).not.toBeNull();
    expect(row?.repair_attempts).toBeGreaterThanOrEqual(1);
    expect(tomb).toBeFalsy(); // No tombstone yet — budget not exhausted
  });

  test("terminal-deletes blob_ready=0 row after maxRepairAttempts confirmed misses", async () => {
    const fakeHash = "0".repeat(64);
    const artId = await simulateCrashedSave(fakeHash, 0);

    // maxRepairAttempts=1 → the very first confirmed miss terminal-deletes.
    store = await createArtifactStore({ dbPath, blobDir, maxRepairAttempts: 1 });
    const r = await store.getArtifact(artId as never, {
      sessionId: sessionId("sess_a"),
    });
    expect(r.ok).toBe(false);

    await store.close();
    const db = new Database(dbPath);
    const row = db.query("SELECT 1 FROM artifacts WHERE id = ?").get(artId);
    const tomb = db.query("SELECT 1 FROM pending_blob_deletes WHERE hash = ?").get(fakeHash);
    db.close();
    store = await createArtifactStore({ dbPath, blobDir });
    expect(row).toBeFalsy(); // Row terminal-deleted
    expect(tomb).toBeTruthy(); // Tombstone enqueued
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

describe("startup recovery — grace window stale intent drain (spec §6.5 step 1)", () => {
  let blobDir: string;
  let dbPath: string;
  let store: ArtifactStore;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-art-grace-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
  });

  afterEach(async () => {
    if (store !== undefined) await store.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  // Seed a stale pre-insert intent (artifact_id=NULL) with a chosen created_at.
  function seedStaleIntent(args: {
    readonly hash: string;
    readonly createdAt: number;
    readonly artifactId?: string | null;
  }): string {
    // Open/close the store to run migrations and DDL.
    // (createArtifactStore does this; test uses createArtifactStore before seeding.)
    const db = new Database(dbPath);
    const intentId = `intent_${crypto.randomUUID()}`;
    const artifactId = args.artifactId === undefined ? null : args.artifactId;
    db.query(
      `INSERT INTO pending_blob_puts (intent_id, hash, artifact_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(intentId, args.hash, artifactId, args.createdAt);
    db.close();
    return intentId;
  }

  function seedArtifactRow(args: { readonly hash: string; readonly blobReady: 0 | 1 }): string {
    const db = new Database(dbPath);
    const artId = `art_${crypto.randomUUID()}`;
    const now = Date.now();
    db.query(
      `INSERT INTO artifacts (id, session_id, name, version, mime_type, size, content_hash, created_at, blob_ready)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(artId, "sess_a", "x.txt", 1, "text/plain", 3, args.hash, now, args.blobReady);
    db.close();
    return artId;
  }

  test("stale intent WITH existing artifacts row → intent deleted, no tombstone", async () => {
    // First open+close to apply schema.
    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();

    const hash = "a".repeat(64);
    // Artifact row exists at blob_ready=0 (any state per spec §6.5 step 1).
    seedArtifactRow({ hash, blobReady: 0 });
    // Stale pre-insert intent older than grace window (10 min ago).
    const staleCreatedAt = Date.now() - 10 * 60 * 1000;
    const intentId = seedStaleIntent({ hash, createdAt: staleCreatedAt, artifactId: null });

    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();

    const db = new Database(dbPath);
    const intentRow = db.query("SELECT 1 FROM pending_blob_puts WHERE intent_id = ?").get(intentId);
    const tomb = db.query("SELECT 1 FROM pending_blob_deletes WHERE hash = ?").get(hash);
    db.close();

    expect(intentRow).toBeFalsy(); // intent deleted
    expect(tomb).toBeFalsy(); // no tombstone — artifacts row still references the hash
  });

  test("stale intent WITHOUT artifacts row → intent deleted AND tombstone enqueued", async () => {
    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();

    const hash = "b".repeat(64);
    const staleCreatedAt = Date.now() - 10 * 60 * 1000;
    const intentId = seedStaleIntent({ hash, createdAt: staleCreatedAt, artifactId: null });

    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();

    const db = new Database(dbPath);
    const intentRow = db.query("SELECT 1 FROM pending_blob_puts WHERE intent_id = ?").get(intentId);
    const tomb = db.query("SELECT 1 FROM pending_blob_deletes WHERE hash = ?").get(hash);
    db.close();

    expect(intentRow).toBeFalsy();
    expect(tomb).toBeTruthy();
  });

  test("intent within grace window is NOT touched", async () => {
    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();

    const hash = "c".repeat(64);
    // 1 minute ago — well within default 5 min grace window.
    const freshCreatedAt = Date.now() - 60 * 1000;
    const intentId = seedStaleIntent({ hash, createdAt: freshCreatedAt, artifactId: null });

    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();

    const db = new Database(dbPath);
    const intentRow = db.query("SELECT 1 FROM pending_blob_puts WHERE intent_id = ?").get(intentId);
    const tomb = db.query("SELECT 1 FROM pending_blob_deletes WHERE hash = ?").get(hash);
    db.close();

    expect(intentRow).toBeTruthy(); // untouched
    expect(tomb).toBeFalsy(); // no tombstone enqueued
  });

  test("staleIntentGraceMs = 0 makes every intent stale", async () => {
    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();

    const hash = "d".repeat(64);
    // "Fresh" intent — but grace=0 makes it stale.
    const intentId = seedStaleIntent({ hash, createdAt: Date.now(), artifactId: null });

    store = await createArtifactStore({ dbPath, blobDir, staleIntentGraceMs: 0 });
    await store.close();

    const db = new Database(dbPath);
    const intentRow = db.query("SELECT 1 FROM pending_blob_puts WHERE intent_id = ?").get(intentId);
    const tomb = db.query("SELECT 1 FROM pending_blob_deletes WHERE hash = ?").get(hash);
    db.close();

    expect(intentRow).toBeFalsy();
    expect(tomb).toBeTruthy();
  });

  test("rejects negative staleIntentGraceMs at construction", async () => {
    await expect(createArtifactStore({ dbPath, blobDir, staleIntentGraceMs: -1 })).rejects.toThrow(
      /staleIntentGraceMs/,
    );
  });

  test("rejects non-integer staleIntentGraceMs at construction", async () => {
    await expect(createArtifactStore({ dbPath, blobDir, staleIntentGraceMs: 1.5 })).rejects.toThrow(
      /staleIntentGraceMs/,
    );
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
