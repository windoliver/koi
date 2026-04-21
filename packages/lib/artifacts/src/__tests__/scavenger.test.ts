/**
 * Scavenger tests — spec §6.4.
 *
 * `scavengeOrphanBlobs()` rebuilds the tombstone journal from a real backing
 * store when the DB was truncated / restored and tombstones were lost. It
 * NEVER deletes blobs directly — every candidate is journaled via
 * `pending_blob_deletes` then handed off to Phase B (§6.3).
 *
 * Covers:
 *   - no-op when every blob has a live reference (artifacts row)
 *   - stranded blob (no row, no tombstone, no intent) → journaled and
 *     drained via Phase B (blob deleted, tombstone reconciled)
 *   - blob referenced only by `pending_blob_puts` → preserved
 *     (in-flight save must not race-lose its bytes)
 *   - hash already in `pending_blob_deletes` → INSERT OR IGNORE no-ops,
 *     Phase B drains normally
 *   - concurrent save interleaving: save journals a `pending_blob_puts`
 *     intent AFTER scavenger's pass1_live snapshot but BEFORE Phase B's
 *     claim — Phase B claim predicate blocks the delete, blob survives
 *   - returns `{ deleted, bytesReclaimed }` reflecting Phase B outcome.
 *     `bytesReclaimed` is 0 in Plan 3 (backing store doesn't surface sizes
 *     to list() and we deliberately avoid re-reading deleted blobs).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BlobStore, createFilesystemBlobStore } from "@koi/blob-cas";
import { createScavengerOrphanBlobs } from "../scavenger.js";
import { ALL_DDL } from "../schema.js";

interface TestCtx {
  readonly db: Database;
  readonly blobDir: string;
  readonly blobStore: BlobStore;
}

function makeCtx(): TestCtx {
  const blobDir = join(tmpdir(), `koi-art-scav-${crypto.randomUUID()}`);
  mkdirSync(blobDir, { recursive: true });
  const db = new Database(":memory:");
  for (const ddl of ALL_DDL) db.exec(ddl);
  const blobStore = createFilesystemBlobStore(blobDir);
  return { db, blobDir, blobStore };
}

function insertArtifact(db: Database, id: string, hash: string, sessionId = "sess_a"): void {
  // Use id as the artifact name to sidestep the UNIQUE (session_id, name,
  // version) constraint — tests insert multiple rows into the same session.
  db.query(
    `INSERT INTO artifacts
       (id, session_id, name, version, mime_type, size, content_hash, tags, created_at, expires_at, blob_ready)
     VALUES (?, ?, ?, 1, 'text/plain', 4, ?, '[]', ?, NULL, 1)`,
  ).run(id, sessionId, id, hash, Date.now());
}

function insertIntent(db: Database, hash: string): void {
  db.query(
    "INSERT INTO pending_blob_puts (intent_id, hash, artifact_id, created_at) VALUES (?, ?, NULL, ?)",
  ).run(`intent_${crypto.randomUUID()}`, hash, Date.now());
}

function tombstoneCount(db: Database, hash: string): number {
  const row = db
    .query("SELECT COUNT(*) AS c FROM pending_blob_deletes WHERE hash = ?")
    .get(hash) as { readonly c: number };
  return row.c;
}

describe("scavengeOrphanBlobs", () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
    rmSync(ctx.blobDir, { recursive: true, force: true });
  });

  test("no-op when every blob has a live artifacts reference", async () => {
    const h1 = await ctx.blobStore.put(new TextEncoder().encode("one"));
    const h2 = await ctx.blobStore.put(new TextEncoder().encode("two"));
    insertArtifact(ctx.db, "art_1", h1);
    insertArtifact(ctx.db, "art_2", h2);

    const scavenge = createScavengerOrphanBlobs({ db: ctx.db, blobStore: ctx.blobStore });
    const result = await scavenge();

    expect(result.deleted).toBe(0);
    expect(result.bytesReclaimed).toBe(0);
    expect(await ctx.blobStore.has(h1)).toBe(true);
    expect(await ctx.blobStore.has(h2)).toBe(true);
    expect(tombstoneCount(ctx.db, h1)).toBe(0);
    expect(tombstoneCount(ctx.db, h2)).toBe(0);
  });

  test("stranded blob (no row, no tombstone, no intent) → journaled and deleted via Phase B", async () => {
    const live = await ctx.blobStore.put(new TextEncoder().encode("live"));
    const orphan = await ctx.blobStore.put(new TextEncoder().encode("orphan"));
    insertArtifact(ctx.db, "art_live", live);
    // `orphan` has no row, no tombstone, no intent — classic DR scenario.

    const scavenge = createScavengerOrphanBlobs({ db: ctx.db, blobStore: ctx.blobStore });
    const result = await scavenge();

    expect(result.deleted).toBe(1);
    // bytesReclaimed is documented 0 (Plan 3 limitation); see scavenger.ts.
    expect(result.bytesReclaimed).toBe(0);

    // Live blob untouched.
    expect(await ctx.blobStore.has(live)).toBe(true);
    // Orphan blob gone via Phase B.
    expect(await ctx.blobStore.has(orphan)).toBe(false);
    // Tombstone reconciled by Phase B.
    expect(tombstoneCount(ctx.db, orphan)).toBe(0);
  });

  test("blob referenced only by pending_blob_puts (in-flight save) is preserved", async () => {
    const h = await ctx.blobStore.put(new TextEncoder().encode("inflight"));
    // No artifacts row (save hasn't reached step 5 yet), but intent present.
    insertIntent(ctx.db, h);

    const scavenge = createScavengerOrphanBlobs({ db: ctx.db, blobStore: ctx.blobStore });
    const result = await scavenge();

    expect(result.deleted).toBe(0);
    expect(await ctx.blobStore.has(h)).toBe(true);
    // No tombstone journaled at all — the intent kept the hash in pass1_live.
    expect(tombstoneCount(ctx.db, h)).toBe(0);
  });

  test("hash already tombstoned stays in pass1_live (INSERT OR IGNORE no-op), Phase B drains normally", async () => {
    // A prior sweep already tombstoned this orphan. Scavenger must coexist:
    // INSERT OR IGNORE prevents a UNIQUE conflict; Phase B still drains.
    const h = await ctx.blobStore.put(new TextEncoder().encode("pre-tombstoned"));
    ctx.db
      .query("INSERT INTO pending_blob_deletes (hash, enqueued_at) VALUES (?, ?)")
      .run(h, Date.now());

    const scavenge = createScavengerOrphanBlobs({ db: ctx.db, blobStore: ctx.blobStore });
    const result = await scavenge();

    expect(result.deleted).toBe(1);
    expect(await ctx.blobStore.has(h)).toBe(false);
    expect(tombstoneCount(ctx.db, h)).toBe(0);
  });

  test("concurrent save interleaving — save journals pending_blob_puts after pass1_live, Phase B claim blocks delete", async () => {
    // Spec §6.4 race: scavenger snapshots pass1_live, THEN a save journals
    // its put intent, THEN scavenger INSERTs the candidate tombstone, THEN
    // Phase B runs claim — the claim predicate `NOT EXISTS (pending_blob_puts
    // WHERE hash = ?)` must block the delete. Blob survives; stale tombstone
    // is cleared by claimTombstone's NOT-orphan fallback.
    const h = await ctx.blobStore.put(new TextEncoder().encode("raced"));

    // Wrap list() so the test injects the save-journaling step AFTER the
    // scavenger has iterated past this hash but BEFORE its enqueue tx.
    const real = ctx.blobStore;
    const interleaving: BlobStore = {
      put: real.put,
      get: real.get,
      has: real.has,
      delete: real.delete,
      list: async function* () {
        for await (const hash of real.list()) {
          yield hash;
        }
        // After list() exhausts, the scavenger is about to open its
        // BEGIN IMMEDIATE enqueue tx. Simulate the concurrent save's step 3
        // journaling its intent in the same moment — this models the race
        // window the spec analyzes.
        insertIntent(ctx.db, h);
      },
    };

    const scavenge = createScavengerOrphanBlobs({ db: ctx.db, blobStore: interleaving });
    const result = await scavenge();

    // Phase B's claim predicate blocked the delete → blob intact.
    expect(await real.has(h)).toBe(true);
    // claimTombstone detected the orphan condition no longer holds (intent
    // exists) and cleaned up the stale tombstone.
    expect(tombstoneCount(ctx.db, h)).toBe(0);
    // Not counted as a reclaim — Phase B's reconcile saw 0 changes.
    expect(result.deleted).toBe(0);
  });

  test("mixed live + orphan in a single pass", async () => {
    const live = await ctx.blobStore.put(new TextEncoder().encode("alive"));
    const orphan1 = await ctx.blobStore.put(new TextEncoder().encode("orphan1"));
    const orphan2 = await ctx.blobStore.put(new TextEncoder().encode("orphan2"));
    const intentOnly = await ctx.blobStore.put(new TextEncoder().encode("intent"));

    insertArtifact(ctx.db, "art_live", live);
    insertIntent(ctx.db, intentOnly);

    const scavenge = createScavengerOrphanBlobs({ db: ctx.db, blobStore: ctx.blobStore });
    const result = await scavenge();

    expect(result.deleted).toBe(2);
    expect(await ctx.blobStore.has(live)).toBe(true);
    expect(await ctx.blobStore.has(intentOnly)).toBe(true);
    expect(await ctx.blobStore.has(orphan1)).toBe(false);
    expect(await ctx.blobStore.has(orphan2)).toBe(false);
  });

  test("empty backing store → trivial no-op", async () => {
    const scavenge = createScavengerOrphanBlobs({ db: ctx.db, blobStore: ctx.blobStore });
    const result = await scavenge();

    expect(result.deleted).toBe(0);
    expect(result.bytesReclaimed).toBe(0);
  });

  test("does not hold DB lock during blob list iteration", async () => {
    // A blob_list iteration that opens an unrelated write tx mid-stream must
    // not deadlock. Verifies the scavenger iterates list() without any
    // open transaction.
    const h = await ctx.blobStore.put(new TextEncoder().encode("iter"));

    const real = ctx.blobStore;
    let wroteDuringList = false;
    const observer: BlobStore = {
      put: real.put,
      get: real.get,
      has: real.has,
      delete: real.delete,
      list: async function* () {
        for await (const hash of real.list()) {
          // Open a short write tx — should succeed (no lock held).
          ctx.db.exec("BEGIN IMMEDIATE; COMMIT;");
          wroteDuringList = true;
          yield hash;
        }
      },
    };

    const scavenge = createScavengerOrphanBlobs({ db: ctx.db, blobStore: observer });
    await scavenge();

    expect(wroteDuringList).toBe(true);
    expect(await real.has(h)).toBe(false);
  });
});
