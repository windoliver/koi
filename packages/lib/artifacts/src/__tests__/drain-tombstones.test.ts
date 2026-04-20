/**
 * Phase B tombstone drain tests — spec §6.3.
 *
 * Covers every row of the spec's race-analysis table:
 *   - Claim-delete-reconcile happy path
 *   - Claim fails: live artifacts row references hash → tombstone cleaned up
 *   - Claim fails: pending_blob_puts intent references hash → tombstone stays
 *   - Blob delete ENOENT/404 treated as success (idempotent)
 *   - Blob delete throws → claimed_at retained → next drain retries
 *   - Concurrent save reclaims tombstone mid-drain → reconcile 0 changes
 *   - Idempotent across restarts (identical outcome when re-run)
 *   - Resume-from-claimed on first scan
 *
 * Uses a real filesystem BlobStore (not a mock) so the test exercises the
 * actual ENOENT path for double-delete. Mock BlobStores are used only where
 * we need to inject a throw or observe call ordering.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BlobStore, createFilesystemBlobStore } from "@koi/blob-cas";
import { createDrainTombstones } from "../drain-tombstones.js";
import { ALL_DDL } from "../schema.js";

interface TestCtx {
  readonly db: Database;
  readonly blobDir: string;
  readonly blobStore: BlobStore;
}

function makeCtx(): TestCtx {
  const blobDir = join(tmpdir(), `koi-art-drain-${crypto.randomUUID()}`);
  mkdirSync(blobDir, { recursive: true });
  const db = new Database(":memory:");
  for (const ddl of ALL_DDL) db.exec(ddl);
  const blobStore = createFilesystemBlobStore(blobDir);
  return { db, blobDir, blobStore };
}

function tombstone(db: Database, hash: string, enqueuedAt = Date.now()): void {
  db.query(
    "INSERT INTO pending_blob_deletes (hash, enqueued_at, claimed_at) VALUES (?, ?, NULL)",
  ).run(hash, enqueuedAt);
}

function tombstoneRow(
  db: Database,
  hash: string,
): { readonly hash: string; readonly claimed_at: number | null } | null {
  return db.query("SELECT hash, claimed_at FROM pending_blob_deletes WHERE hash = ?").get(hash) as {
    readonly hash: string;
    readonly claimed_at: number | null;
  } | null;
}

describe("drainTombstones Phase B", () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
    rmSync(ctx.blobDir, { recursive: true, force: true });
  });

  test("claims unclaimed tombstone → deletes blob → reconciles row", async () => {
    const hash = await ctx.blobStore.put(new TextEncoder().encode("reapme"));
    tombstone(ctx.db, hash);

    const drain = createDrainTombstones({ db: ctx.db, blobStore: ctx.blobStore });
    const result = await drain();

    expect(result.reclaimed).toBe(1);
    expect(tombstoneRow(ctx.db, hash)).toBeNull();
    expect(await ctx.blobStore.has(hash)).toBe(false);
  });

  test("claim fails when live artifact row references hash → tombstone cleaned up", async () => {
    // Save a row ourselves with the same content_hash; tombstone exists
    // (e.g. enqueued by a buggy/ancient sweep). Drain must NOT delete the
    // blob but MUST clean up the stale tombstone.
    const hash = await ctx.blobStore.put(new TextEncoder().encode("stay"));
    tombstone(ctx.db, hash);

    const now = Date.now();
    ctx.db
      .query(
        `INSERT INTO artifacts
           (id, session_id, name, version, mime_type, size, content_hash, tags, created_at, expires_at, blob_ready)
         VALUES ('art_a', 'sess_a', 'x.txt', 1, 'text/plain', 4, ?, '[]', ?, NULL, 1)`,
      )
      .run(hash, now);

    const drain = createDrainTombstones({ db: ctx.db, blobStore: ctx.blobStore });
    const result = await drain();

    expect(result.reclaimed).toBe(0);
    expect(tombstoneRow(ctx.db, hash)).toBeNull();
    // Blob must survive because the live row still references it.
    expect(await ctx.blobStore.has(hash)).toBe(true);
  });

  test("claim fails when pending_blob_puts intent references hash → tombstone cleaned up, blob survives", async () => {
    // An in-flight save has journaled an intent for the same hash. The
    // tombstone is stale from a prior sweep. Drain must preserve the blob
    // and sweep the stale tombstone (orphan condition no longer holds).
    const hash = await ctx.blobStore.put(new TextEncoder().encode("inflight"));
    tombstone(ctx.db, hash);
    ctx.db
      .query(
        "INSERT INTO pending_blob_puts (intent_id, hash, artifact_id, created_at) VALUES (?, ?, NULL, ?)",
      )
      .run(`intent_${crypto.randomUUID()}`, hash, Date.now());

    const drain = createDrainTombstones({ db: ctx.db, blobStore: ctx.blobStore });
    const result = await drain();

    expect(result.reclaimed).toBe(0);
    expect(tombstoneRow(ctx.db, hash)).toBeNull();
    expect(await ctx.blobStore.has(hash)).toBe(true);
  });

  test("blobStore.delete returns false for ENOENT → treated as success (reconcile runs)", async () => {
    // Tombstone for a hash whose bytes were already deleted out-of-band
    // (or by a prior crashed drain that deleted the blob but crashed before
    // reconcile, and the row was manually reset to claimed_at=NULL).
    // Real FS BlobStore returns false from delete() on ENOENT — the drain
    // must still reconcile the tombstone row.
    const hash = "a".repeat(64);
    tombstone(ctx.db, hash);

    const drain = createDrainTombstones({ db: ctx.db, blobStore: ctx.blobStore });
    const result = await drain();

    expect(result.reclaimed).toBe(1);
    expect(tombstoneRow(ctx.db, hash)).toBeNull();
  });

  test("blobStore.delete throws → tombstone retains claimed_at, next drain retries (resume-from-claimed)", async () => {
    const hash = await ctx.blobStore.put(new TextEncoder().encode("throws"));
    tombstone(ctx.db, hash);

    // Wrap the real store: first delete() throws, subsequent calls
    // delegate to the real impl so the retry succeeds.
    const real = ctx.blobStore;
    let deleteCalls = 0;
    const flaky: BlobStore = {
      put: real.put,
      get: real.get,
      has: real.has,
      list: real.list,
      delete: async (h) => {
        deleteCalls++;
        if (deleteCalls === 1) throw new Error("transient-failure");
        return real.delete(h);
      },
    };

    const drainOnce = createDrainTombstones({ db: ctx.db, blobStore: flaky });
    const r1 = await drainOnce();
    expect(r1.reclaimed).toBe(0);

    // Tombstone must still be there with claimed_at set — the claim was
    // durable BEFORE the blob I/O attempt, so resume-from-claimed applies.
    const mid = tombstoneRow(ctx.db, hash);
    expect(mid).not.toBeNull();
    expect(mid?.claimed_at).not.toBeNull();
    // Blob is still present — the throwing delete did not reach the FS.
    expect(await real.has(hash)).toBe(true);

    // Second drain hits the resume-from-claimed path: no re-claim, straight
    // to blob delete + reconcile.
    const r2 = await drainOnce();
    expect(r2.reclaimed).toBe(1);
    expect(tombstoneRow(ctx.db, hash)).toBeNull();
    expect(await real.has(hash)).toBe(false);
    expect(deleteCalls).toBe(2);
  });

  test("concurrent save reclaims tombstone mid-drain — reconcile 0 changes, blob recoverable via post-commit re-put", async () => {
    // Model the R4 race: sweep has committed the claim (claimed_at != NULL,
    // lock released). BEFORE blob I/O runs, a concurrent saveArtifact's
    // metadata tx sees the claimed tombstone, reclaims it, and inserts a
    // blob_ready=0 row. Sweep's blob delete then runs — removes bytes.
    // Finally sweep's reconcile tries to delete the tombstone, finds 0 rows.
    //
    // In this task we only verify the drain's side of the contract:
    // reconcile-with-0-changes is a normal outcome; the concurrent save's
    // post-commit re-put (§6.1 step 7) is what re-creates the bytes.
    const hash = await ctx.blobStore.put(new TextEncoder().encode("raced"));
    tombstone(ctx.db, hash);

    // Wrap the store: the blob.delete() step simulates the concurrent save
    // by clearing the tombstone and inserting a live row before calling the
    // real delete. This is the exact interleaving from the spec table.
    const real = ctx.blobStore;
    const interleaving: BlobStore = {
      put: real.put,
      get: real.get,
      has: real.has,
      list: real.list,
      delete: async (h) => {
        // Concurrent saveArtifact mid-drain: the save already observed
        // claimed_at != NULL, cleared the tombstone, and re-inserted a
        // live artifact row pointing at the hash.
        ctx.db.query("DELETE FROM pending_blob_deletes WHERE hash = ?").run(h);
        ctx.db
          .query(
            `INSERT INTO artifacts
               (id, session_id, name, version, mime_type, size, content_hash, tags, created_at, expires_at, blob_ready)
             VALUES ('art_raced', 'sess_a', 'r.txt', 1, 'text/plain', 5, ?, '[]', ?, NULL, 0)`,
          )
          .run(h, Date.now());
        return real.delete(h);
      },
    };

    const drain = createDrainTombstones({ db: ctx.db, blobStore: interleaving });
    const result = await drain();

    // Reconcile saw 0 changes — concurrent save handled the row. That is
    // NOT counted as a reclaim.
    expect(result.reclaimed).toBe(0);
    // Tombstone is gone (cleared by the racing save).
    expect(tombstoneRow(ctx.db, hash)).toBeNull();
    // Blob was deleted; the concurrent save's post-commit re-put (Task 7)
    // will resurrect it. In this test we only verify the drain's side.
    expect(await real.has(hash)).toBe(false);
  });

  test("resume-from-claimed: row with claimed_at != NULL on first scan → delete + reconcile, no re-claim", async () => {
    // Prior crash left a tombstone with claimed_at durably set. On next
    // drain, we must skip the re-claim (it would fail anyway because the
    // predicate requires claimed_at IS NULL) and resume: delete + reconcile.
    const hash = await ctx.blobStore.put(new TextEncoder().encode("claimed"));
    const past = Date.now() - 10_000;
    ctx.db
      .query("INSERT INTO pending_blob_deletes (hash, enqueued_at, claimed_at) VALUES (?, ?, ?)")
      .run(hash, past, past + 1);

    const drain = createDrainTombstones({ db: ctx.db, blobStore: ctx.blobStore });
    const result = await drain();

    expect(result.reclaimed).toBe(1);
    expect(tombstoneRow(ctx.db, hash)).toBeNull();
    expect(await ctx.blobStore.has(hash)).toBe(false);
  });

  test("idempotent across restarts — running same pending state twice yields identical outcome", async () => {
    const hashes = [
      await ctx.blobStore.put(new TextEncoder().encode("one")),
      await ctx.blobStore.put(new TextEncoder().encode("two")),
      await ctx.blobStore.put(new TextEncoder().encode("three")),
    ];
    for (const h of hashes) tombstone(ctx.db, h);

    const drain = createDrainTombstones({ db: ctx.db, blobStore: ctx.blobStore });
    const first = await drain();
    expect(first.reclaimed).toBe(3);

    // Second run: nothing to do, no spurious state changes.
    const second = await drain();
    expect(second.reclaimed).toBe(0);

    for (const h of hashes) {
      expect(tombstoneRow(ctx.db, h)).toBeNull();
      expect(await ctx.blobStore.has(h)).toBe(false);
    }
  });

  test("does NOT hold DB lock while blob delete runs", async () => {
    // Verify the claim tx commits before blob I/O starts by observing
    // claimed_at from a fresh query inside the blob.delete() hook.
    const hash = await ctx.blobStore.put(new TextEncoder().encode("locked"));
    tombstone(ctx.db, hash);

    const real = ctx.blobStore;
    let observed: number | null = null;
    const observer: BlobStore = {
      put: real.put,
      get: real.get,
      has: real.has,
      list: real.list,
      delete: async (h) => {
        const row = ctx.db
          .query("SELECT claimed_at FROM pending_blob_deletes WHERE hash = ?")
          .get(h) as { readonly claimed_at: number | null } | null;
        observed = row?.claimed_at ?? null;
        return real.delete(h);
      },
    };

    const drain = createDrainTombstones({ db: ctx.db, blobStore: observer });
    await drain();

    // claimed_at must be readable (and non-null) from outside the claim tx
    // while blob I/O is in flight — confirms the tx committed first.
    expect(observed).not.toBeNull();
  });
});
