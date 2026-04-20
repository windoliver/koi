/**
 * Phase A `sweepArtifacts()` — metadata sweep tests (spec §6.3 Phase A).
 *
 * Covers:
 *   - No-op when policy is empty
 *   - TTL-expired rows reaped
 *   - blob_ready=0 rows NEVER candidates (protects active saves)
 *   - Quota excess — oldest rows dropped first until under limit
 *   - Retention excess — oldest versions per (session,name) dropped, latest N kept
 *   - Shared artifact's share row CASCADEs on row delete
 *   - Hash referenced by a surviving row is NOT tombstoned
 *   - Hash referenced only by deleted rows IS tombstoned (ON CONFLICT DO NOTHING)
 *   - Phase A row DELETE + tombstone INSERT occur in the same tx
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionId } from "@koi/core";
import { createArtifactStore } from "../create-store.js";
import type { Artifact, ArtifactStore, LifecyclePolicy } from "../types.js";

interface TestCtx {
  readonly blobDir: string;
  readonly dbPath: string;
}

function randDirs(): TestCtx {
  const blobDir = join(tmpdir(), `koi-art-sweep-${crypto.randomUUID()}`);
  mkdirSync(blobDir, { recursive: true });
  return { blobDir, dbPath: join(blobDir, "store.db") };
}

async function save(
  store: ArtifactStore,
  sid: string,
  name: string,
  text: string,
): Promise<Artifact> {
  const r = await store.saveArtifact({
    sessionId: sessionId(sid),
    name,
    data: new TextEncoder().encode(text),
    mimeType: "text/plain",
  });
  if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

async function open(ctx: TestCtx, policy?: LifecyclePolicy): Promise<ArtifactStore> {
  return await createArtifactStore({
    dbPath: ctx.dbPath,
    blobDir: ctx.blobDir,
    ...(policy !== undefined ? { policy } : {}),
  });
}

describe("sweepArtifacts Phase A", () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = randDirs();
  });

  afterEach(() => {
    rmSync(ctx.blobDir, { recursive: true, force: true });
  });

  test("no-op when policy is empty", async () => {
    const store = await open(ctx);
    await save(store, "sess_a", "a.txt", "hello");
    await save(store, "sess_a", "b.txt", "world");

    const result = await store.sweepArtifacts();

    expect(result.deleted).toBe(0);
    expect(result.bytesReclaimed).toBe(0);

    const list = await store.listArtifacts({}, { sessionId: sessionId("sess_a") });
    expect(list).toHaveLength(2);
    await store.close();
  });

  test("TTL-expired rows reaped", async () => {
    const store = await open(ctx, { ttlMs: 1 });
    const art = await save(store, "sess_a", "a.txt", "hello");

    // Wait past the TTL.
    await new Promise<void>((r) => setTimeout(r, 10));

    const result = await store.sweepArtifacts();

    expect(result.deleted).toBe(1);
    expect(result.bytesReclaimed).toBe(art.size);

    const list = await store.listArtifacts({}, { sessionId: sessionId("sess_a") });
    expect(list).toHaveLength(0);

    // Tombstone is enqueued for the unique hash.
    await store.close();
    const db = new Database(ctx.dbPath);
    const tomb = db
      .query("SELECT hash FROM pending_blob_deletes WHERE hash = ?")
      .get(art.contentHash);
    db.close();
    expect(tomb).toBeTruthy();
  });

  test("in-flight (blob_ready=0) rows are NEVER candidates", async () => {
    // Open with no policy first so we can save a committed row whose
    // expires_at is NULL, then manually inject a blob_ready=0 row with
    // expires_at in the past.
    const store = await open(ctx, { ttlMs: 1 });
    await save(store, "sess_a", "visible.txt", "data");

    // Shut down, inject an in-flight row whose expires_at is in the past,
    // and a matching intent so startup recovery doesn't reap the row.
    await store.close();
    const db = new Database(ctx.dbPath);
    const id = "art_inflight_fixture";
    const hash = "a".repeat(64);
    const past = Date.now() - 1_000_000;
    db.query(
      `INSERT INTO artifacts
         (id, session_id, name, version, mime_type, size, content_hash, tags, created_at, expires_at, blob_ready)
       VALUES (?, 'sess_a', 'inflight.txt', 1, 'text/plain', 3, ?, '[]', ?, ?, 0)`,
    ).run(id, hash, past, past + 1);
    db.query(
      "INSERT INTO pending_blob_puts (intent_id, hash, artifact_id, created_at) VALUES (?, ?, ?, ?)",
    ).run(`intent_${crypto.randomUUID()}`, hash, id, Date.now());
    db.close();

    // Re-open WITHOUT configuring ttl to keep startup recovery quiet.
    // The in-flight row's intent + artifact_id keeps recovery from reaping it
    // (blob_ready=0 path: has() will fail, repair_attempts bumps, not reaped).
    const store2 = await open(ctx, { ttlMs: 10 });

    await store2.sweepArtifacts();

    // The in-flight row MUST still be there — sweep must not touch blob_ready=0.
    await store2.close();
    const db2 = new Database(ctx.dbPath);
    const row = db2.query("SELECT blob_ready FROM artifacts WHERE id = ?").get(id) as {
      readonly blob_ready: number;
    } | null;
    db2.close();
    expect(row).toBeTruthy();
    expect(row?.blob_ready).toBe(0);
  });

  test("quota excess — oldest rows dropped first until under limit", async () => {
    // Admission control prevents going over quota on save, so the path a
    // sweep must correct is a policy tightening after rows exist. Open with
    // no policy, save 3 rows of 5 bytes each (total 15), then re-open with
    // maxSessionBytes=12. Sweep must drop the oldest to reach <= 12.
    const store = await open(ctx);
    const a = await save(store, "sess_a", "a.txt", "xxxxx");
    await new Promise<void>((r) => setTimeout(r, 5));
    const b = await save(store, "sess_a", "b.txt", "yyyyy");
    await new Promise<void>((r) => setTimeout(r, 5));
    const c = await save(store, "sess_a", "c.txt", "zzzzz");
    await store.close();

    const store2 = await open(ctx, { maxSessionBytes: 12 });
    const result = await store2.sweepArtifacts();

    expect(result.deleted).toBe(1);
    expect(result.bytesReclaimed).toBe(a.size);

    const list = await store2.listArtifacts({}, { sessionId: sessionId("sess_a") });
    const ids = list.map((x) => x.id).sort();
    expect(ids).toEqual([b.id, c.id].sort());
    await store2.close();
  });

  test("retention excess — oldest versions per (session,name) dropped, latest N kept", async () => {
    const store = await open(ctx, { maxVersionsPerName: 2 });

    const v1 = await save(store, "sess_a", "doc.txt", "v1111");
    await new Promise<void>((r) => setTimeout(r, 5));
    const v2 = await save(store, "sess_a", "doc.txt", "v2222");
    await new Promise<void>((r) => setTimeout(r, 5));
    const v3 = await save(store, "sess_a", "doc.txt", "v3333");

    const result = await store.sweepArtifacts();

    expect(result.deleted).toBe(1);
    expect(result.bytesReclaimed).toBe(v1.size);

    const list = await store.listArtifacts({ name: "doc.txt" }, { sessionId: sessionId("sess_a") });
    const versions = list.map((x) => x.version).sort();
    expect(versions).toEqual([v2.version, v3.version].sort());
    await store.close();
  });

  test("shared artifact's share row CASCADEs when parent row is reaped", async () => {
    const store = await open(ctx, { ttlMs: 1 });
    const art = await save(store, "sess_a", "s.txt", "shared");

    const shareRes = await store.shareArtifact(art.id, sessionId("sess_b"), {
      ownerSessionId: sessionId("sess_a"),
    });
    expect(shareRes.ok).toBe(true);

    await new Promise<void>((r) => setTimeout(r, 10));

    await store.sweepArtifacts();

    await store.close();
    const db = new Database(ctx.dbPath);
    const shareCount = db
      .query("SELECT COUNT(*) AS c FROM artifact_shares WHERE artifact_id = ?")
      .get(art.id) as { readonly c: number };
    db.close();
    expect(shareCount.c).toBe(0);
  });

  test("hash referenced by a surviving row is NOT tombstoned", async () => {
    // Two rows, identical bytes (same hash), different names so they are
    // distinct rows in the same session. Open policy-free, save both (each
    // 16 bytes; session total = 32), then reopen with maxSessionBytes=20
    // so exactly one of them (the oldest) is quota-evicted. The survivor
    // keeps the hash alive → NO tombstone.
    const store = await open(ctx);
    const older = await save(store, "sess_a", "a.txt", "samebytes_______");
    await new Promise<void>((r) => setTimeout(r, 5));
    const newer = await save(store, "sess_a", "b.txt", "samebytes_______");
    expect(older.contentHash).toBe(newer.contentHash);
    await store.close();

    const store2 = await open(ctx, { maxSessionBytes: 20 });
    const result = await store2.sweepArtifacts();
    expect(result.deleted).toBe(1);

    await store2.close();
    const db = new Database(ctx.dbPath);
    const tomb = db
      .query("SELECT hash FROM pending_blob_deletes WHERE hash = ?")
      .get(older.contentHash);
    db.close();
    expect(tomb).toBeNull();
  });

  test("hash referenced only by deleted rows IS tombstoned exactly once", async () => {
    // Two distinct rows with DIFFERENT hashes; both reaped by TTL.
    // Both get tombstones. The uniqueness invariant on hash is enforced
    // by the table's PRIMARY KEY/ON CONFLICT DO NOTHING.
    const store = await open(ctx, { ttlMs: 1 });
    const a = await save(store, "sess_a", "a.txt", "alpha");
    const b = await save(store, "sess_a", "b.txt", "beta");
    expect(a.contentHash).not.toBe(b.contentHash);

    await new Promise<void>((r) => setTimeout(r, 10));

    await store.sweepArtifacts();

    // Sweep again — should be a no-op; tombstones must not double up.
    await store.sweepArtifacts();

    await store.close();
    const db = new Database(ctx.dbPath);
    const rows = db
      .query("SELECT hash FROM pending_blob_deletes ORDER BY hash")
      .all() as ReadonlyArray<{ readonly hash: string }>;
    db.close();
    expect(rows).toHaveLength(2);
    const hashes = rows.map((r) => r.hash).sort();
    expect(hashes).toEqual([a.contentHash, b.contentHash].sort());
  });

  test("hash referenced by an in-flight pending_blob_puts intent is NOT tombstoned", async () => {
    // Simulate a crashed save whose blob_ready=1 sibling is TTL-expired.
    // The sibling gets reaped; the in-flight sibling's intent still holds
    // the hash alive, so no tombstone.
    const store = await open(ctx, { ttlMs: 1 });
    const art = await save(store, "sess_a", "x.txt", "inflight-shared");

    // Inject a separate in-flight row + matching intent for the SAME hash.
    await store.close();
    const db = new Database(ctx.dbPath);
    const ghostId = "art_ghost";
    db.query(
      `INSERT INTO artifacts
         (id, session_id, name, version, mime_type, size, content_hash, tags, created_at, expires_at, blob_ready)
       VALUES (?, 'sess_b', 'ghost.txt', 1, 'text/plain', 3, ?, '[]', ?, NULL, 0)`,
    ).run(ghostId, art.contentHash, Date.now());
    const intentId = `intent_${crypto.randomUUID()}`;
    db.query(
      "INSERT INTO pending_blob_puts (intent_id, hash, artifact_id, created_at) VALUES (?, ?, ?, ?)",
    ).run(intentId, art.contentHash, ghostId, Date.now());
    db.close();

    const store2 = await open(ctx, { ttlMs: 1 });
    // Give TTL a chance.
    await new Promise<void>((r) => setTimeout(r, 10));
    await store2.sweepArtifacts();

    // The committed row is gone (TTL-expired), but the hash should still be
    // referenced by the in-flight intent → no tombstone.
    await store2.close();
    const db2 = new Database(ctx.dbPath);
    const tomb = db2
      .query("SELECT hash FROM pending_blob_deletes WHERE hash = ?")
      .get(art.contentHash);
    db2.close();
    expect(tomb).toBeNull();
  });

  test("rejects when store is closing", async () => {
    const store = await open(ctx, { ttlMs: 1 });
    await save(store, "sess_a", "a.txt", "x");
    const closing = store.close();
    await expect(store.sweepArtifacts()).rejects.toThrow(/closing|closed/);
    await closing;
  });
});
