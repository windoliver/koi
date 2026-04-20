import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlobStore } from "@koi/blob-cas";
import { sessionId } from "@koi/core";
import type { ArtifactStore } from "../types.js";

/**
 * Counting blobStore mock. Static ESM imports of `@koi/blob-cas` everywhere
 * in @koi/artifacts are redirected through this factory so we can count
 * every `has()` / `put()` / `delete()` / `list()` the open path makes.
 *
 * Spec §6.5 Plan 4: the critical path of `createArtifactStore` MUST NOT
 * touch the backend. Only `ensureStoreIdPair`'s sentinel check may walk
 * `list()` — and only on the first ever open (both sides empty) or on an
 * asymmetric recovery path. A clean re-open must observe zero calls.
 */
const counters = { has: 0, put: 0, delete: 0, list: 0 };
function resetCounters(): void {
  counters.has = 0;
  counters.put = 0;
  counters.delete = 0;
  counters.list = 0;
}

const loadRealBlobCas = (): typeof import("@koi/blob-cas") =>
  require("../../../../../packages/lib/blob-cas/src/index.ts");

mock.module("@koi/blob-cas", () => {
  const realModule = loadRealBlobCas();
  return {
    createFilesystemBlobStore: (blobDir: string): BlobStore => {
      const real = realModule.createFilesystemBlobStore(blobDir);
      return {
        put: (data) => {
          counters.put++;
          return real.put(data);
        },
        get: (hash) => real.get(hash),
        has: (hash) => {
          counters.has++;
          return real.has(hash);
        },
        delete: (hash) => {
          counters.delete++;
          return real.delete(hash);
        },
        list: () => {
          counters.list++;
          return real.list();
        },
        // Forward the FS sentinel — Plan 5 routes store-id pairing through
        // `blobStore.sentinel`, so tests wrapping the real store must
        // preserve it.
        ...(real.sentinel !== undefined ? { sentinel: real.sentinel } : {}),
      };
    },
  };
});

import { createArtifactStore } from "../create-store.js";

describe("startup recovery — open path blob-I/O invariants (Plan 4 §6.5)", () => {
  let blobDir: string;
  let dbPath: string;
  let store: ArtifactStore | undefined;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-art-rec-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
    resetCounters();
  });

  afterEach(async () => {
    if (store !== undefined) await store.close();
    store = undefined;
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("clean re-open: zero has/put/delete/list calls", async () => {
    // First open bootstraps the store_id pair (sentinel write) — may call
    // list() once inside ensureStoreIdPair for the empty-store check. That
    // isn't a blob probe; discount it by resetting counters after bootstrap.
    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    resetCounters();
    store = await createArtifactStore({ dbPath, blobDir });
    expect(counters.has).toBe(0);
    expect(counters.put).toBe(0);
    expect(counters.delete).toBe(0);
    expect(counters.list).toBe(0);
  });

  test("re-open with blob_ready=0 row + bound intent: zero has/put/delete/list calls", async () => {
    // Seed the shape that Plan 2 recovery would have probed: a crashed-mid-
    // save row at blob_ready=0 with a matching pending_blob_puts intent.
    // Plan 4 open MUST leave it alone; the worker owns blob probes.
    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    const db = new Database(dbPath);
    const artId = `art_${crypto.randomUUID()}`;
    const hash = "f".repeat(64);
    const now = Date.now();
    db.query(
      `INSERT INTO artifacts (id, session_id, name, version, mime_type, size, content_hash, created_at, blob_ready)
       VALUES (?, 'sess_a', 'crashed.txt', 1, 'text/plain', 3, ?, ?, 0)`,
    ).run(artId, hash, now);
    const intentId = `intent_${crypto.randomUUID()}`;
    db.query(
      `INSERT INTO pending_blob_puts (intent_id, hash, artifact_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(intentId, hash, artId, now);
    db.close();

    resetCounters();
    store = await createArtifactStore({ dbPath, blobDir });
    expect(counters.has).toBe(0);
    expect(counters.put).toBe(0);
    expect(counters.delete).toBe(0);
    expect(counters.list).toBe(0);
  });

  test("blob_ready=0 row with bound intent survives open untouched", async () => {
    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    const db = new Database(dbPath);
    const artId = `art_${crypto.randomUUID()}`;
    const hash = "a".repeat(64);
    const now = Date.now();
    db.query(
      `INSERT INTO artifacts (id, session_id, name, version, mime_type, size, content_hash, created_at, blob_ready)
       VALUES (?, 'sess_a', 'crashed.txt', 1, 'text/plain', 3, ?, ?, 0)`,
    ).run(artId, hash, now);
    const intentId = `intent_${crypto.randomUUID()}`;
    db.query(
      `INSERT INTO pending_blob_puts (intent_id, hash, artifact_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(intentId, hash, artId, now);
    db.close();

    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    const db2 = new Database(dbPath);
    const row = db2.query("SELECT blob_ready FROM artifacts WHERE id = ?").get(artId) as {
      readonly blob_ready: number;
    } | null;
    const intent = db2.query("SELECT 1 FROM pending_blob_puts WHERE intent_id = ?").get(intentId);
    const tomb = db2.query("SELECT 1 FROM pending_blob_deletes WHERE hash = ?").get(hash);
    db2.close();

    expect(row).not.toBeNull();
    expect(row?.blob_ready).toBe(0);
    expect(intent).toBeTruthy(); // intent stays — worker will probe
    expect(tomb).toBeFalsy();
  });

  test("retires stale pending_blob_puts when matching blob_ready=1 row exists", async () => {
    // Already-resolved bound intent path: target row is blob_ready=1, so
    // no blob I/O is needed to retire the intent.
    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    const db = new Database(dbPath);
    const artId = `art_${crypto.randomUUID()}`;
    const hash = "b".repeat(64);
    const now = Date.now();
    db.query(
      `INSERT INTO artifacts (id, session_id, name, version, mime_type, size, content_hash, created_at, blob_ready)
       VALUES (?, 'sess_a', 'ok.txt', 1, 'text/plain', 3, ?, ?, 1)`,
    ).run(artId, hash, now);
    const intentId = `intent_${crypto.randomUUID()}`;
    db.query(
      `INSERT INTO pending_blob_puts (intent_id, hash, artifact_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(intentId, hash, artId, now);
    db.close();

    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    const db2 = new Database(dbPath);
    const count = db2
      .query("SELECT COUNT(*) AS c FROM pending_blob_puts WHERE intent_id = ?")
      .get(intentId) as { readonly c: number };
    db2.close();
    expect(count.c).toBe(0);
  });

  test("tombstones + retires intent when target row was externally deleted", async () => {
    // artifact_id bound, target row missing → the externally-deleted branch.
    // No blob I/O needed: we just tombstone + retire.
    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    const db = new Database(dbPath);
    const ghostArtId = `art_${crypto.randomUUID()}`;
    const hash = "c".repeat(64);
    const now = Date.now();
    const intentId = `intent_${crypto.randomUUID()}`;
    db.query(
      `INSERT INTO pending_blob_puts (intent_id, hash, artifact_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(intentId, hash, ghostArtId, now);
    db.close();

    resetCounters();
    store = await createArtifactStore({ dbPath, blobDir });
    expect(counters.has).toBe(0);
    expect(counters.put).toBe(0);
    expect(counters.delete).toBe(0);
    expect(counters.list).toBe(0);
    await store.close();
    store = undefined;

    const db2 = new Database(dbPath);
    const intent = db2.query("SELECT 1 FROM pending_blob_puts WHERE intent_id = ?").get(intentId);
    const tomb = db2.query("SELECT 1 FROM pending_blob_deletes WHERE hash = ?").get(hash);
    db2.close();
    expect(intent).toBeFalsy();
    expect(tomb).toBeTruthy();
  });
});

describe("sweepTtlOnOpen (spec §6.5 step 3)", () => {
  let blobDir: string;
  let dbPath: string;
  let store: ArtifactStore | undefined;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-art-ttlopen-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
    resetCounters();
  });

  afterEach(async () => {
    if (store !== undefined) await store.close();
    store = undefined;
    rmSync(blobDir, { recursive: true, force: true });
  });

  // Seed a committed (blob_ready=1) row with a chosen expires_at so we can
  // exercise sweepTtlOnOpen's selection predicate deterministically.
  function seedCommittedRow(args: {
    readonly sessionId?: string;
    readonly name?: string;
    readonly version?: number;
    readonly hash?: string;
    readonly size?: number;
    readonly createdAt?: number;
    readonly expiresAt: number | null;
    readonly blobReady?: 0 | 1;
  }): string {
    const db = new Database(dbPath);
    const id = `art_${crypto.randomUUID()}`;
    const hash = args.hash ?? crypto.randomUUID().replace(/-/g, "") + "a".repeat(32);
    db.query(
      `INSERT INTO artifacts
         (id, session_id, name, version, mime_type, size, content_hash, tags, created_at, expires_at, blob_ready)
       VALUES (?, ?, ?, ?, 'text/plain', ?, ?, '[]', ?, ?, ?)`,
    ).run(
      id,
      args.sessionId ?? "sess_a",
      args.name ?? `f_${crypto.randomUUID()}.txt`,
      args.version ?? 1,
      args.size ?? 10,
      hash,
      args.createdAt ?? Date.now(),
      args.expiresAt,
      args.blobReady ?? 1,
    );
    db.close();
    return id;
  }

  test("TTL-expired rows are reaped + tombstoned on open", async () => {
    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    const hash = "d".repeat(64);
    const past = Date.now() - 10_000;
    const id = seedCommittedRow({ expiresAt: past, hash });

    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    const db = new Database(dbPath);
    const row = db.query("SELECT 1 FROM artifacts WHERE id = ?").get(id);
    const tomb = db.query("SELECT 1 FROM pending_blob_deletes WHERE hash = ?").get(hash);
    db.close();
    expect(row).toBeFalsy();
    expect(tomb).toBeTruthy();
  });

  test("TTL-not-yet-expired rows survive open", async () => {
    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    const future = Date.now() + 60_000;
    const id = seedCommittedRow({ expiresAt: future });

    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    const db = new Database(dbPath);
    const row = db.query("SELECT 1 FROM artifacts WHERE id = ?").get(id);
    db.close();
    expect(row).toBeTruthy();
  });

  test("quota-over rows NOT reaped on open (even with maxSessionBytes set)", async () => {
    // Two rows, total 20 bytes, maxSessionBytes=5 → full sweep would reap
    // both. sweepTtlOnOpen must reap nothing because expires_at is NULL.
    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    const idA = seedCommittedRow({
      sessionId: "sess_q",
      name: "a.txt",
      size: 10,
      expiresAt: null,
      createdAt: Date.now() - 2000,
    });
    const idB = seedCommittedRow({
      sessionId: "sess_q",
      name: "b.txt",
      size: 10,
      expiresAt: null,
      createdAt: Date.now() - 1000,
    });

    store = await createArtifactStore({ dbPath, blobDir, policy: { maxSessionBytes: 5 } });
    await store.close();
    store = undefined;

    const db = new Database(dbPath);
    const rows = db
      .query("SELECT id FROM artifacts WHERE id IN (?, ?)")
      .all(idA, idB) as ReadonlyArray<{ readonly id: string }>;
    db.close();
    expect(rows).toHaveLength(2);
  });

  test("retention-excess rows NOT reaped on open (even with maxVersionsPerName set)", async () => {
    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    const idV1 = seedCommittedRow({
      sessionId: "sess_r",
      name: "doc.txt",
      version: 1,
      expiresAt: null,
      createdAt: Date.now() - 3000,
    });
    const idV2 = seedCommittedRow({
      sessionId: "sess_r",
      name: "doc.txt",
      version: 2,
      expiresAt: null,
      createdAt: Date.now() - 2000,
    });
    const idV3 = seedCommittedRow({
      sessionId: "sess_r",
      name: "doc.txt",
      version: 3,
      expiresAt: null,
      createdAt: Date.now() - 1000,
    });

    store = await createArtifactStore({ dbPath, blobDir, policy: { maxVersionsPerName: 2 } });
    await store.close();
    store = undefined;

    const db = new Database(dbPath);
    const rows = db
      .query("SELECT id FROM artifacts WHERE id IN (?, ?, ?)")
      .all(idV1, idV2, idV3) as ReadonlyArray<{ readonly id: string }>;
    db.close();
    expect(rows).toHaveLength(3);
  });

  test("blob_ready=0 rows NOT reaped on open (even when TTL-expired)", async () => {
    // In-flight row's expires_at is already in the past. `selectTtlExpired`
    // filters on blob_ready=1 so this row is never a candidate.
    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    const past = Date.now() - 10_000;
    const hash = "e".repeat(64);
    const id = seedCommittedRow({
      hash,
      expiresAt: past,
      blobReady: 0,
    });

    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    const db = new Database(dbPath);
    const row = db.query("SELECT blob_ready FROM artifacts WHERE id = ?").get(id) as {
      readonly blob_ready: number;
    } | null;
    const tomb = db.query("SELECT 1 FROM pending_blob_deletes WHERE hash = ?").get(hash);
    db.close();
    expect(row).not.toBeNull();
    expect(row?.blob_ready).toBe(0);
    expect(tomb).toBeFalsy();
  });

  test("sweepTtlOnOpen makes zero blob-I/O calls", async () => {
    // Single seeded TTL-expired row, matching + non-matching intent shapes,
    // and a rebootstrapped store. The open path is NOT allowed to call
    // has/put/delete, and the Plan 4 worker is the only thing that drains
    // tombstones, so list() stays at 0 too.
    store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    store = undefined;

    const past = Date.now() - 10_000;
    seedCommittedRow({ expiresAt: past });

    resetCounters();
    store = await createArtifactStore({ dbPath, blobDir });
    expect(counters.has).toBe(0);
    expect(counters.put).toBe(0);
    expect(counters.delete).toBe(0);
    expect(counters.list).toBe(0);
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
