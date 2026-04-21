import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlobStore } from "@koi/blob-cas";
import { sessionId } from "@koi/core";

// Mutable "delete gate" used by the mutation-barrier drain tests below. When
// set to a promise, any blob delete call inside Phase B blocks until the gate
// resolves — lets the test pause a drain mid-flight, then assert close() is
// still pending, then resolve the gate and watch close() finish. Default:
// undefined → pass-through (all other tests behave identically to the real
// filesystem store).
const deleteGate: { pending: Promise<void> | undefined } = { pending: undefined };

// Mutable "has gate" used by the Plan 4 Task 6 worker close-barrier tests.
// When set to a promise, any `blobStore.has(...)` call blocks until the gate
// resolves. Same shape as `deleteGate` above; lets tests hang a worker
// iteration mid-`drainBlobReadyZero` probe, assert close() is still pending,
// then release and confirm close() drains the iteration before resolving.
const hasGate: { pending: Promise<void> | undefined } = { pending: undefined };

// Counter for `blobStore.has(...)` calls. The "no ticks after close" test
// samples this counter across a close() + wait interval to prove the worker
// loop is fully quiesced. Reset in each close-barrier test's beforeEach.
const hasCounter: { count: number } = { count: 0 };

// Pass-through mock that wraps `delete` in the gate. The mock factory must
// reach the REAL createFilesystemBlobStore (not itself); `require()` bypasses
// bun:test's ESM mock layer, giving us the unwrapped module. Static ESM
// imports of "@koi/blob-cas" elsewhere (including inside @koi/artifacts) go
// through this mock and therefore observe the gated delete behavior.
//
// The helper types `require()`'s `any` return to the real module's shape, so
// no `as` cast is needed. The workspace symlink resolves the on-disk path at
// both runtime and typecheck.
const loadRealBlobCas = (): typeof import("@koi/blob-cas") =>
  require("../../../../../packages/lib/blob-cas/src/index.ts");

mock.module("@koi/blob-cas", () => {
  const realModule = loadRealBlobCas();
  return {
    createFilesystemBlobStore: (blobDir: string): BlobStore => {
      const real = realModule.createFilesystemBlobStore(blobDir);
      return {
        put: real.put,
        get: real.get,
        has: async (hash: string): Promise<boolean> => {
          hasCounter.count++;
          if (hasGate.pending !== undefined) await hasGate.pending;
          return real.has(hash);
        },
        list: real.list,
        delete: async (hash: string): Promise<boolean> => {
          if (deleteGate.pending !== undefined) await deleteGate.pending;
          return real.delete(hash);
        },
        // Forward the real FS sentinel — Plan 5 routes store-id pairing
        // through `blobStore.sentinel`, so omitting it here would make every
        // test that calls `createArtifactStore` fail with "missing sentinel".
        ...(real.sentinel !== undefined ? { sentinel: real.sentinel } : {}),
      };
    },
  };
});

import { createFilesystemBlobStore } from "@koi/blob-cas";
import { createArtifactStore } from "../create-store.js";

describe("createArtifactStore (skeleton)", () => {
  let blobDir: string;
  let dbPath: string;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-art-store-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("opens a fresh store (both sides empty → bootstraps store_id)", async () => {
    const store = await createArtifactStore({ dbPath, blobDir });
    expect(typeof store.close).toBe("function");
    await store.close();
  });

  test("second open while first is alive throws", async () => {
    const store = await createArtifactStore({ dbPath, blobDir });
    await expect(createArtifactStore({ dbPath, blobDir })).rejects.toThrow(
      /already open by another process/,
    );
    await store.close();
  });

  test("re-open after close succeeds", async () => {
    const s1 = await createArtifactStore({ dbPath, blobDir });
    await s1.close();
    const s2 = await createArtifactStore({ dbPath, blobDir });
    await s2.close();
  });

  test("close is idempotent", async () => {
    const store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    await store.close();
  });

  test.each([
    { value: 0, label: "zero" },
    { value: -1, label: "negative" },
    { value: 0.5, label: "fractional" },
    { value: Number.NaN, label: "NaN" },
    { value: Number.POSITIVE_INFINITY, label: "Infinity" },
  ])("rejects invalid maxRepairAttempts: $label", async ({ value }) => {
    await expect(
      createArtifactStore({ dbPath, blobDir, maxRepairAttempts: value }),
    ).rejects.toThrow(/maxRepairAttempts/);
  });

  test.each([
    { value: 0, label: "zero" },
    { value: -1, label: "negative" },
    { value: 0.5, label: "fractional" },
    { value: Number.NaN, label: "NaN" },
    { value: Number.POSITIVE_INFINITY, label: "Infinity" },
  ])("rejects invalid maxArtifactBytes: $label", async ({ value }) => {
    await expect(createArtifactStore({ dbPath, blobDir, maxArtifactBytes: value })).rejects.toThrow(
      /maxArtifactBytes/,
    );
  });

  test("rejects non-memory SQLite URI dbPath", async () => {
    await expect(
      createArtifactStore({ dbPath: "file:/tmp/x.db?cache=shared", blobDir }),
    ).rejects.toThrow(/non-memory SQLite URI paths.*not supported in Plan 2/);
  });

  test("accepts SQLite in-memory URI dbPath", async () => {
    const store = await createArtifactStore({
      dbPath: "file:memtest?mode=memory&cache=shared",
      blobDir,
    });
    await store.close();
  });
});

/**
 * Plan 5: `blobStore` override on `ArtifactStoreConfig`. Callers may supply a
 * non-FS backend (S3, in-memory, etc.); the store routes all reads/writes +
 * the store-id sentinel through that backend and skips all FS-specific
 * bootstrap (no `mkdirSync(blobDir)`, no default filesystem factory).
 */
describe("createArtifactStore (blobStore override, Plan 5)", () => {
  let dbPath: string;
  let blobDir: string;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-art-ovr-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  /** In-memory `BlobStore` backed by a `Map` + its own sentinel. */
  function createMemBackend(): BlobStore {
    const blobs = new Map<string, Uint8Array>();
    const sentinelState: { value: string | undefined } = { value: undefined };
    async function hashHex(data: Uint8Array): Promise<string> {
      const h = new Bun.CryptoHasher("sha256");
      h.update(data);
      return h.digest("hex");
    }
    async function* list(): AsyncIterable<string> {
      for (const k of blobs.keys()) yield k;
    }
    return {
      put: async (data) => {
        const h = await hashHex(data);
        blobs.set(h, data);
        return h;
      },
      get: async (h) => blobs.get(h),
      has: async (h) => blobs.has(h),
      delete: async (h) => blobs.delete(h),
      list,
      sentinel: {
        readStoreId: async () => sentinelState.value,
        writeStoreId: async (uuid) => {
          sentinelState.value = uuid;
        },
      },
    };
  }

  test("accepts blobStore override (no throw)", async () => {
    const override = createMemBackend();
    const store = await createArtifactStore({ dbPath, blobDir, blobStore: override });
    expect(typeof store.close).toBe("function");
    await store.close();
  });

  test("override + omitted blobDir: save/get round-trips without touching the FS", async () => {
    const override = createMemBackend();
    // :memory: DB so nothing hits the filesystem at all.
    const store = await createArtifactStore({
      dbPath: ":memory:",
      blobStore: override,
    });
    const save = await store.saveArtifact({
      sessionId: sessionId("sess_a"),
      name: "a.txt",
      data: new TextEncoder().encode("hello"),
      mimeType: "text/plain",
    });
    if (!save.ok) throw new Error(`save failed: ${save.error.kind}`);
    const got = await store.getArtifact(save.value.id, { sessionId: sessionId("sess_a") });
    if (!got.ok) throw new Error(`get failed: ${got.error.kind}`);
    expect(new TextDecoder().decode(got.value.data)).toBe("hello");
    // The backend actually holds the bytes (proving the override was used).
    expect(await override.has(save.value.contentHash)).toBe(true);
    await store.close();
  });

  test("override + persistent DB: store-id sentinel lives on the backend, not the FS", async () => {
    const override = createMemBackend();
    const store = await createArtifactStore({ dbPath, blobDir, blobStore: override });
    await store.close();
    // FS sentinel was never written — override owns its own sentinel.
    expect(existsSync(join(blobDir, ".store-id"))).toBe(false);
    const raw = await override.sentinel?.readStoreId();
    expect(raw).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("neither blobDir nor blobStore → throws", async () => {
    // Both fields are optional on the type (either satisfies construction),
    // so the runtime guard is the only line of defense.
    await expect(createArtifactStore({ dbPath: ":memory:" })).rejects.toThrow(
      /requires either `blobDir`.*or `blobStore`/,
    );
  });
});

describe("createArtifactStore close-barrier", () => {
  let blobDir: string;
  let dbPath: string;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-art-store-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
    // Every test starts with the gate open; individual tests arm it.
    deleteGate.pending = undefined;
  });

  afterEach(() => {
    // Release the gate unconditionally so a failed test doesn't hang the suite.
    deleteGate.pending = undefined;
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("scavengeOrphanBlobs rejects when store is closing", async () => {
    // Mirrors the existing sweep "rejects when closing" test at
    // sweep.test.ts:318. Start close(), then prove the public scavenge call
    // short-circuits via the mutation barrier.
    const store = await createArtifactStore({ dbPath, blobDir });
    const closing = store.close();
    await expect(store.scavengeOrphanBlobs()).rejects.toThrow(/closing|closed/);
    await closing;
  });

  test("close() awaits in-flight sweepArtifacts before closing SQLite", async () => {
    // Seed a TTL-expired, tombstone-worthy row so Phase B actually has a blob
    // to delete. Arm the gate so the first blob delete inside Phase B hangs.
    // Kick off sweep + close, verify close is still pending while drain hangs,
    // then release the gate and verify close resolves. Crucially, sweep's
    // trailing `reconcileTombstone` (drain-tombstones.ts) runs a DB query
    // AFTER the gated delete — so `await sweeping` not rejecting is itself
    // proof the store's internal SQLite handle stayed open during the drain.
    const store = await createArtifactStore({ dbPath, blobDir, policy: { ttlMs: 1 } });
    const save = await store.saveArtifact({
      sessionId: sessionId("sess_a"),
      name: "a.txt",
      data: new TextEncoder().encode("x"),
      mimeType: "text/plain",
    });
    if (!save.ok) throw new Error("save failed");

    // Wait past the TTL so sweep will reap this row and tombstone its hash.
    await new Promise<void>((r) => setTimeout(r, 10));

    // Arm the gate BEFORE sweep so Phase B's first delete hangs.
    let release: () => void = () => {};
    deleteGate.pending = new Promise<void>((r) => {
      release = r;
    });

    const sweeping = store.sweepArtifacts();
    // Let the event loop advance so Phase A commits and Phase B reaches the
    // hanging delete call. A macrotask is enough — the transaction is sync.
    await new Promise<void>((r) => setTimeout(r, 10));

    const closing = store.close();

    // close() must NOT resolve while drain is mid-flight. Race it against a
    // resolved-microtask so any already-resolved close() would win.
    const winner = await Promise.race([
      closing.then(() => "close" as const),
      Promise.resolve().then(() => "pending" as const),
    ]);
    expect(winner).toBe("pending");

    // Release the gate. Drain resumes: reconcileTombstone runs a DELETE
    // against the store's internal db — if close() had already fired
    // `db.close()`, this await would reject. It doesn't → db stayed open.
    release();
    await sweeping;
    await closing;
  });

  test("close() awaits in-flight scavengeOrphanBlobs before closing SQLite", async () => {
    // Same shape as the sweep drain test. Plant an orphan blob the scavenger
    // will tombstone + try to drain; the gated delete hangs Phase B; close()
    // must wait for drain's post-delete reconcile (another db.query) to finish.
    const store = await createArtifactStore({ dbPath, blobDir });
    const save = await store.saveArtifact({
      sessionId: sessionId("sess_a"),
      name: "live.txt",
      data: new TextEncoder().encode("live"),
      mimeType: "text/plain",
    });
    if (!save.ok) throw new Error("save failed");

    // put() is pass-through through the mock (only delete is gated), so we
    // can plant the orphan against the same blobDir without help from the store.
    const orphanStore = createFilesystemBlobStore(blobDir);
    await orphanStore.put(new TextEncoder().encode("orphan"));

    let release: () => void = () => {};
    deleteGate.pending = new Promise<void>((r) => {
      release = r;
    });

    const scavenging = store.scavengeOrphanBlobs();
    await new Promise<void>((r) => setTimeout(r, 10));

    const closing = store.close();

    const winner = await Promise.race([
      closing.then(() => "close" as const),
      Promise.resolve().then(() => "pending" as const),
    ]);
    expect(winner).toBe("pending");

    release();
    await scavenging;
    await closing;
  });
});

/**
 * Plan 4 Task 6: close-barrier worker integration. The worker is spun up by
 * `createArtifactStore` and must be torn down by `close()` BEFORE the drain
 * for other in-flight ops, so a mid-flight `drainBlobReadyZero` (blobStore.has
 * probe + per-row DB tx) finishes before the store closes its SQLite handle.
 *
 * Seed path: `saveArtifact` then flip `blob_ready` back to 0 via a raw DB
 * handle while the store is closed. Next open, the worker's first iteration
 * calls `blobStore.has(hash)` on that row — which is either gated (tests 1+3)
 * or counted (test 2).
 */
async function seedBlobReadyZeroRow(dbPath: string, blobDir: string): Promise<void> {
  const { createArtifactStore } = await import("../create-store.js");
  const store = await createArtifactStore({
    dbPath,
    blobDir,
    // Disable scheduled worker ticks during seed — we only want saveArtifact
    // to land, then we manipulate blob_ready=0 offline. A live worker would
    // race the seed by promoting the row back to blob_ready=1.
    workerIntervalMs: "manual",
  });
  const save = await store.saveArtifact({
    sessionId: sessionId("sess_seed"),
    name: "seed.txt",
    data: new TextEncoder().encode("seed-payload"),
    mimeType: "text/plain",
  });
  if (!save.ok) throw new Error(`seed save failed: ${save.error.kind}`);
  await store.close();
  // Flip blob_ready back to 0 for the seeded row. This mirrors the natural
  // state a save leaves behind if its post-commit repair crashes — exactly
  // what the worker's drainBlobReadyZero pass is designed to resolve.
  const raw = new Database(dbPath);
  try {
    raw.exec("PRAGMA journal_mode = WAL;");
    raw.query("UPDATE artifacts SET blob_ready = 0 WHERE id = ?").run(save.value.id);
  } finally {
    raw.close();
  }
}

describe("createArtifactStore close-barrier (worker, Plan 4 Task 6)", () => {
  let blobDir: string;
  let dbPath: string;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-art-store-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
    hasGate.pending = undefined;
    hasCounter.count = 0;
  });

  afterEach(() => {
    // Release the gate unconditionally so a failed test doesn't hang the
    // suite — an un-released gate would trap the next test's worker in an
    // unresolvable await.
    hasGate.pending = undefined;
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("close() awaits in-flight worker iteration before closing SQLite", async () => {
    // Seed a blob_ready=0 row so the worker's first iteration calls
    // blobStore.has() — our gated mock hangs that probe, which keeps the
    // iteration mid-flight until the test releases the gate.
    await seedBlobReadyZeroRow(dbPath, blobDir);
    // Zero the counter AFTER seed: saveArtifact's post-commit repair path
    // calls has() internally; we want the worker-only contribution below.
    hasCounter.count = 0;

    // Arm the has-gate BEFORE opening so the very first scheduled tick hangs.
    let release: () => void = () => {};
    hasGate.pending = new Promise<void>((r) => {
      release = r;
    });

    const store = await createArtifactStore({
      dbPath,
      blobDir,
      workerIntervalMs: 100,
    });

    // Wait long enough for the first scheduled tick to fire and enter the
    // gated has() call. 150ms >> 100ms interval.
    await new Promise<void>((r) => setTimeout(r, 150));
    // Prove the iteration actually reached the gate (otherwise a failing
    // test below could be a false negative from "iteration never started").
    expect(hasCounter.count).toBeGreaterThan(0);

    const closing = store.close();

    // close() must NOT resolve while the worker iteration is gated.
    const winner = await Promise.race([
      closing.then(() => "close" as const),
      Promise.resolve().then(() => "pending" as const),
    ]);
    expect(winner).toBe("pending");

    // Release the gate. The iteration completes its has() probe + the rest
    // of drainBlobReadyZero / drainTombstones, then stop() resolves, then
    // close() proceeds through db.close() + releaseLock().
    release();
    await closing;
  });

  test("no worker ticks fire after close() resolves", async () => {
    await seedBlobReadyZeroRow(dbPath, blobDir);
    hasCounter.count = 0;

    const store = await createArtifactStore({
      dbPath,
      blobDir,
      workerIntervalMs: 100,
    });

    // Let at least one tick run so we know the worker is alive and hitting
    // has() against the seeded row. 300ms / 100ms = ~3 iterations worth; a
    // 1-iteration floor tolerates CI jitter.
    await new Promise<void>((r) => setTimeout(r, 300));
    expect(hasCounter.count).toBeGreaterThanOrEqual(1);

    await store.close();
    const countAtClose = hasCounter.count;

    // Wait a window longer than the interval. If the worker's interval timer
    // weren't cleared by stop(), we'd observe at least 2 more ticks here.
    await new Promise<void>((r) => setTimeout(r, 300));
    expect(hasCounter.count).toBe(countAtClose);
  });

  test("concurrent close() calls share the same stop promise (idempotent while worker iterates)", async () => {
    await seedBlobReadyZeroRow(dbPath, blobDir);
    hasCounter.count = 0;

    let release: () => void = () => {};
    hasGate.pending = new Promise<void>((r) => {
      release = r;
    });

    const store = await createArtifactStore({
      dbPath,
      blobDir,
      workerIntervalMs: 100,
    });

    // Wait for the first tick to enter the gated has() probe.
    await new Promise<void>((r) => setTimeout(r, 150));
    expect(hasCounter.count).toBeGreaterThan(0);

    // Two concurrent close() calls while the worker iteration is still
    // mid-has(). Both must be pending until the gate releases; both must
    // resolve against the same underlying stop+drain+close work (no double
    // db.close(), no "ArtifactStore is closed" rejection from the second
    // caller).
    const first = store.close();
    const second = store.close();

    const winner = await Promise.race([
      Promise.all([first, second]).then(() => "both" as const),
      Promise.resolve().then(() => "pending" as const),
    ]);
    expect(winner).toBe("pending");

    release();
    await Promise.all([first, second]);
    // Third close() after resolution is still a no-op, matching the
    // sweep/scavenge close-barrier contract from Plan 3 Task 9.
    await store.close();
  });
});
