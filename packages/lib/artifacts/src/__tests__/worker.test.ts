/**
 * Repair worker lifecycle tests — spec §6.5 step 4.
 *
 * Task 3 scope: start / stop / runOnce / active lifecycle only. Iteration body
 * is a stub that returns zero-stats. Tasks 4–5 fill in the actual drain calls.
 *
 * Invariants asserted here (the contract the later tasks must not break):
 *   - `start` is idempotent; a second call does not create a second interval.
 *   - `stop` awaits any in-flight iteration before resolving (mutation barrier
 *     parity with `close()` — close-time flush via `runOnce()` in Task 6).
 *   - `stop` is idempotent and concurrent callers share the same promise.
 *   - After `stop`, both `start` and `runOnce` throw "worker stopped".
 *   - `workerIntervalMs = "manual"` disables the interval loop; `runOnce`
 *     still works.
 *   - `workerIntervalMs = <ms>` actually schedules iterations.
 *   - Concurrent `runOnce()` calls serialize: the second awaits the first and
 *     both see the same result (no double-execution).
 *   - `active()` is true only while an iteration is running.
 *
 * No real DB / blobStore is needed for Task 3 — the iteration is stubbed. We
 * pass minimal-shape stubs via `unknown` narrowing so the factory signature
 * holds without coupling tests to the (still-forming) Database + BlobStore
 * wiring the worker uses in later tasks.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BlobStore, createFilesystemBlobStore } from "@koi/blob-cas";
import { ALL_DDL } from "../schema.js";
import type { ArtifactStoreConfig } from "../types.js";
import { createRepairWorker } from "../worker.js";

// Minimal no-op stubs. The Task 3 worker body is a zero-stats stub; it never
// touches these. Tests that need a custom iteration hook use the
// `__testIteration` escape hatch (see worker.ts).
const stubDb = {} as unknown as Database;
const stubBlobStore = {} as unknown as BlobStore;

const baseConfig: ArtifactStoreConfig = {
  dbPath: ":memory:",
  blobDir: "/tmp/unused",
};

describe("createRepairWorker — lifecycle (Task 3 scaffolding)", () => {
  // Track every worker we create so an assertion failure can't leak an
  // interval timer into the next test. afterEach stops them all.
  const workers: Array<{ readonly stop: () => Promise<void> }> = [];

  beforeEach(() => {
    workers.length = 0;
  });

  afterEach(async () => {
    for (const w of workers) await w.stop().catch(() => {});
  });

  function track<T extends { readonly stop: () => Promise<void> }>(w: T): T {
    workers.push(w);
    return w;
  }

  test("start → runOnce returns zero stats (via __testIteration stub)", async () => {
    // Lifecycle-only smoke test — uses the test escape hatch so the iteration
    // body doesn't need a real DB + BlobStore. The real-iteration tests below
    // in the "iteration body" describe exercise the wired drains against a
    // live in-memory schema.
    const w = track(
      createRepairWorker({
        db: stubDb,
        blobStore: stubBlobStore,
        config: { ...baseConfig, workerIntervalMs: "manual" },
        maxRepairAttempts: 10,
        __testIteration: async () => ({
          promoted: 0,
          terminallyDeleted: 0,
          transientErrors: 0,
          tombstonesDrained: 0,
          bytesReclaimed: 0,
        }),
      }),
    );
    w.start();
    const stats = await w.runOnce();
    expect(stats).toEqual({
      promoted: 0,
      terminallyDeleted: 0,
      transientErrors: 0,
      tombstonesDrained: 0,
      bytesReclaimed: 0,
    });
  });

  test("start is idempotent — second call does not double-schedule", async () => {
    let iterations = 0;
    const w = track(
      createRepairWorker({
        db: stubDb,
        blobStore: stubBlobStore,
        config: { ...baseConfig, workerIntervalMs: 50 },
        maxRepairAttempts: 10,
        __testIteration: async () => {
          iterations++;
          return {
            promoted: 0,
            terminallyDeleted: 0,
            transientErrors: 0,
            tombstonesDrained: 0,
            bytesReclaimed: 0,
          };
        },
      }),
    );
    w.start();
    w.start(); // second call must be a no-op
    await new Promise<void>((r) => setTimeout(r, 180));
    // With a single 50ms interval we expect roughly 3 ticks in 180ms. If start
    // had double-scheduled we'd see ~6. Use a hard upper bound of 5 to avoid
    // a flaky test on a loaded machine.
    expect(iterations).toBeGreaterThanOrEqual(1);
    expect(iterations).toBeLessThanOrEqual(5);
  });

  test("stop awaits in-flight iteration", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let iterationFinished = false;

    const w = track(
      createRepairWorker({
        db: stubDb,
        blobStore: stubBlobStore,
        config: { ...baseConfig, workerIntervalMs: "manual" },
        maxRepairAttempts: 10,
        __testIteration: async () => {
          await gate;
          iterationFinished = true;
          return {
            promoted: 0,
            terminallyDeleted: 0,
            transientErrors: 0,
            tombstonesDrained: 0,
            bytesReclaimed: 0,
          };
        },
      }),
    );
    w.start();
    const running = w.runOnce();
    // Give the iteration a tick to enter the gated body.
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(w.active()).toBe(true);

    const stopping = w.stop();
    // stop() must not resolve while iteration is in flight.
    const winner = await Promise.race([
      stopping.then(() => "stop" as const),
      Promise.resolve().then(() => "pending" as const),
    ]);
    expect(winner).toBe("pending");
    expect(iterationFinished).toBe(false);

    release();
    await running;
    await stopping;
    expect(iterationFinished).toBe(true);
    expect(w.active()).toBe(false);
  });

  test("stop is idempotent — concurrent callers share the same promise", async () => {
    const w = track(
      createRepairWorker({
        db: stubDb,
        blobStore: stubBlobStore,
        config: { ...baseConfig, workerIntervalMs: "manual" },
        maxRepairAttempts: 10,
      }),
    );
    w.start();
    const a = w.stop();
    const b = w.stop();
    await Promise.all([a, b]);
    // third stop after resolved is still a no-op, not a throw.
    await w.stop();
  });

  test("after stop, start throws 'worker stopped'", async () => {
    const w = track(
      createRepairWorker({
        db: stubDb,
        blobStore: stubBlobStore,
        config: { ...baseConfig, workerIntervalMs: "manual" },
        maxRepairAttempts: 10,
      }),
    );
    w.start();
    await w.stop();
    expect(() => w.start()).toThrow(/worker stopped/);
  });

  test("after stop, runOnce throws 'worker stopped'", async () => {
    const w = track(
      createRepairWorker({
        db: stubDb,
        blobStore: stubBlobStore,
        config: { ...baseConfig, workerIntervalMs: "manual" },
        maxRepairAttempts: 10,
      }),
    );
    w.start();
    await w.stop();
    await expect(w.runOnce()).rejects.toThrow(/worker stopped/);
  });

  test("workerIntervalMs='manual' fires no scheduled iterations", async () => {
    let iterations = 0;
    const w = track(
      createRepairWorker({
        db: stubDb,
        blobStore: stubBlobStore,
        config: { ...baseConfig, workerIntervalMs: "manual" },
        maxRepairAttempts: 10,
        __testIteration: async () => {
          iterations++;
          return {
            promoted: 0,
            terminallyDeleted: 0,
            transientErrors: 0,
            tombstonesDrained: 0,
            bytesReclaimed: 0,
          };
        },
      }),
    );
    w.start();
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(iterations).toBe(0);

    // runOnce still triggers a manual iteration.
    await w.runOnce();
    expect(iterations).toBe(1);
  });

  test("workerIntervalMs=50 fires at least one iteration within ~150ms", async () => {
    let iterations = 0;
    const w = track(
      createRepairWorker({
        db: stubDb,
        blobStore: stubBlobStore,
        config: { ...baseConfig, workerIntervalMs: 50 },
        maxRepairAttempts: 10,
        __testIteration: async () => {
          iterations++;
          return {
            promoted: 0,
            terminallyDeleted: 0,
            transientErrors: 0,
            tombstonesDrained: 0,
            bytesReclaimed: 0,
          };
        },
      }),
    );
    w.start();
    await new Promise<void>((r) => setTimeout(r, 150));
    expect(iterations).toBeGreaterThanOrEqual(1);
  });

  test("concurrent runOnce calls serialize — second awaits first", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let executionCount = 0;
    const w = track(
      createRepairWorker({
        db: stubDb,
        blobStore: stubBlobStore,
        config: { ...baseConfig, workerIntervalMs: "manual" },
        maxRepairAttempts: 10,
        __testIteration: async () => {
          executionCount++;
          await gate;
          return {
            promoted: executionCount,
            terminallyDeleted: 0,
            transientErrors: 0,
            tombstonesDrained: 0,
            bytesReclaimed: 0,
          };
        },
      }),
    );
    w.start();
    const first = w.runOnce();
    // Yield to let the first invocation enter the iteration body before the
    // second call sees the "active" state.
    await new Promise<void>((r) => setTimeout(r, 5));
    const second = w.runOnce();
    expect(executionCount).toBe(1);

    release();
    const [a, b] = await Promise.all([first, second]);
    // Second call shared the first's in-flight promise → identical result.
    expect(executionCount).toBe(1);
    expect(a).toEqual(b);
  });

  test("active() is true during iteration, false before and after", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const w = track(
      createRepairWorker({
        db: stubDb,
        blobStore: stubBlobStore,
        config: { ...baseConfig, workerIntervalMs: "manual" },
        maxRepairAttempts: 10,
        __testIteration: async () => {
          await gate;
          return {
            promoted: 0,
            terminallyDeleted: 0,
            transientErrors: 0,
            tombstonesDrained: 0,
            bytesReclaimed: 0,
          };
        },
      }),
    );
    w.start();
    expect(w.active()).toBe(false);

    const running = w.runOnce();
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(w.active()).toBe(true);

    release();
    await running;
    expect(w.active()).toBe(false);
  });

  test("scheduled iteration that throws is swallowed (does not crash interval)", async () => {
    let calls = 0;
    // Silence the structured warn so the test output stays clean. Task 7's
    // onEvent hook will make this unnecessary.
    const originalWarn = console.warn;
    console.warn = (): void => {};
    try {
      const w = track(
        createRepairWorker({
          db: stubDb,
          blobStore: stubBlobStore,
          config: { ...baseConfig, workerIntervalMs: 50 },
          maxRepairAttempts: 10,
          __testIteration: async () => {
            calls++;
            throw new Error("boom");
          },
        }),
      );
      w.start();
      await new Promise<void>((r) => setTimeout(r, 180));
      // Iterations continued despite each one throwing.
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      console.warn = originalWarn;
    }
  });
});

/**
 * Task 5: iteration body wires `drainBlobReadyZero` (Phase A of the worker)
 * first, then the Phase B tombstone drain. Order matters per spec §6.5 step 4
 * — a terminal-delete in the first drain produces a tombstone that the second
 * drain consumes within the SAME iteration.
 *
 * These tests spin up a real in-memory SQLite with the schema applied and a
 * real filesystem BlobStore (tmp dir per test) so drain ordering is validated
 * end-to-end, not through mocks.
 */
describe("createRepairWorker — iteration body wires both drains (Task 5)", () => {
  const workers: Array<{ readonly stop: () => Promise<void> }> = [];
  const dbs: Array<Database> = [];
  const dirs: Array<string> = [];

  function track<T extends { readonly stop: () => Promise<void> }>(w: T): T {
    workers.push(w);
    return w;
  }

  function makeDb(): Database {
    const db = new Database(":memory:");
    for (const ddl of ALL_DDL) db.exec(ddl);
    dbs.push(db);
    return db;
  }

  function makeBlobDir(): string {
    const dir = join(tmpdir(), `koi-art-worker-iter-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }

  function insertBlobReadyZero(
    db: Database,
    args: {
      readonly id: string;
      readonly hash: string;
      readonly repairAttempts?: number;
    },
  ): void {
    // Name derives from id so (session_id, name, version) stays unique even
    // when multiple rows are seeded in the same test.
    db.query(
      `INSERT INTO artifacts
         (id, session_id, name, version, mime_type, size, content_hash, tags, created_at, expires_at, blob_ready, repair_attempts)
       VALUES (?, 'sess_a', ?, 1, 'text/plain', 4, ?, '[]', ?, NULL, 0, ?)`,
    ).run(args.id, `${args.id}.txt`, args.hash, Date.now(), args.repairAttempts ?? 0);
  }

  beforeEach(() => {
    workers.length = 0;
    dbs.length = 0;
    dirs.length = 0;
  });

  afterEach(async () => {
    for (const w of workers) await w.stop().catch(() => {});
    for (const db of dbs) db.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("iteration runs drainBlobReadyZero FIRST, then drainPendingBlobDeletes", async () => {
    // Shared counter: instrument the BlobStore to record call order. The
    // Phase A drain only calls `has`; Phase B only calls `delete`. If the
    // order is reversed, the sequence would start with `delete`.
    const db = makeDb();
    const blobDir = makeBlobDir();
    const fs = createFilesystemBlobStore(blobDir);

    // Seed Phase A work (blob_ready=0 row whose blob is present → promote).
    const h1 = await fs.put(new TextEncoder().encode("present"));
    insertBlobReadyZero(db, { id: "art_present", hash: h1 });

    // Seed Phase B work (orphan tombstone for a different hash).
    const h2 = await fs.put(new TextEncoder().encode("orphan"));
    db.query(
      "INSERT INTO pending_blob_deletes (hash, enqueued_at, claimed_at) VALUES (?, ?, NULL)",
    ).run(h2, Date.now());

    const calls: Array<string> = [];
    const blobStore: BlobStore = {
      put: fs.put,
      get: fs.get,
      has: async (h) => {
        calls.push(`has:${h.slice(0, 6)}`);
        return fs.has(h);
      },
      delete: async (h) => {
        calls.push(`delete:${h.slice(0, 6)}`);
        return fs.delete(h);
      },
      list: () => fs.list(),
    };

    const w = track(
      createRepairWorker({
        db,
        blobStore,
        config: { ...baseConfig, workerIntervalMs: "manual" },
        maxRepairAttempts: 10,
      }),
    );
    const stats = await w.runOnce();

    // Phase A ran first (has call), then Phase B (delete call).
    expect(calls[0]?.startsWith("has:")).toBe(true);
    expect(calls.some((c) => c.startsWith("delete:"))).toBe(true);
    const firstDeleteIdx = calls.findIndex((c) => c.startsWith("delete:"));
    const lastHasIdx = calls.findIndex((c) => c.startsWith("has:"));
    expect(firstDeleteIdx).toBeGreaterThan(lastHasIdx);

    expect(stats.promoted).toBe(1);
    expect(stats.tombstonesDrained).toBe(1);
  });

  test("terminal-delete in Phase A produces tombstone that Phase B drains in SAME iteration", async () => {
    // Spec §6.5 step 4 rationale: atomicity across the full cycle. One
    // iteration takes a blob_ready=0 row at budget-1 with an absent blob,
    // terminal-deletes it (row gone + tombstone inserted), then Phase B
    // claims + deletes + reconciles — all within runOnce().
    const db = makeDb();
    const blobDir = makeBlobDir();
    const fs = createFilesystemBlobStore(blobDir);

    // Write a real blob at the hash so Phase B's fs.delete works (ENOENT is
    // also fine but we prove the file is actually gone after the iteration).
    const data = new TextEncoder().encode("stale");
    const hash = await fs.put(data);
    // Orphaned metadata pointing at the hash — but force Phase A to consider
    // it absent by wrapping has() to return false.
    insertBlobReadyZero(db, { id: "art_terminal", hash, repairAttempts: 0 });

    const blobStore: BlobStore = {
      put: fs.put,
      get: fs.get,
      // Lie: the blob is on disk, but we want Phase A to terminal-delete
      // the row so we can prove the tombstone is drained in the same pass.
      has: async () => false,
      delete: fs.delete,
      list: () => fs.list(),
    };

    const w = track(
      createRepairWorker({
        db,
        blobStore,
        config: { ...baseConfig, workerIntervalMs: "manual" },
        maxRepairAttempts: 1, // first-attempt terminal
      }),
    );
    const stats = await w.runOnce();

    expect(stats.terminallyDeleted).toBe(1);
    expect(stats.tombstonesDrained).toBe(1);
    // End state: row gone, tombstone gone, blob deleted.
    expect(db.query("SELECT id FROM artifacts WHERE id = ?").get("art_terminal")).toBeNull();
    expect(db.query("SELECT hash FROM pending_blob_deletes WHERE hash = ?").get(hash)).toBeNull();
    expect(await fs.has(hash)).toBe(false);
  });

  test("stats aggregate correctly across both drains", async () => {
    const db = makeDb();
    const blobDir = makeBlobDir();
    const fs = createFilesystemBlobStore(blobDir);

    // Phase A: one promote, one terminal-delete, one transient.
    const hPresent = await fs.put(new TextEncoder().encode("present"));
    insertBlobReadyZero(db, { id: "art_promote", hash: hPresent });
    const hTerm = await fs.put(new TextEncoder().encode("gone"));
    insertBlobReadyZero(db, { id: "art_term", hash: hTerm, repairAttempts: 0 });
    const hTrans = await fs.put(new TextEncoder().encode("trans"));
    insertBlobReadyZero(db, { id: "art_trans", hash: hTrans });

    // Phase B: one orphan tombstone ready to drain.
    const hOrphan = await fs.put(new TextEncoder().encode("orphan"));
    db.query(
      "INSERT INTO pending_blob_deletes (hash, enqueued_at, claimed_at) VALUES (?, ?, NULL)",
    ).run(hOrphan, Date.now());

    const blobStore: BlobStore = {
      put: fs.put,
      get: fs.get,
      has: async (h) => {
        if (h === hPresent) return true;
        if (h === hTerm) return false; // absent → budget-1 terminal
        if (h === hTrans) throw new Error("transient");
        return fs.has(h);
      },
      delete: fs.delete,
      list: () => fs.list(),
    };

    const w = track(
      createRepairWorker({
        db,
        blobStore,
        config: { ...baseConfig, workerIntervalMs: "manual" },
        maxRepairAttempts: 1,
      }),
    );
    const stats = await w.runOnce();

    expect(stats.promoted).toBe(1);
    // Both art_term's Phase-A-terminal tombstone AND hOrphan drain. The
    // Phase A terminal-delete of art_term adds a tombstone for hTerm that
    // Phase B also drains in the same iteration.
    expect(stats.terminallyDeleted).toBe(1);
    expect(stats.transientErrors).toBe(1);
    expect(stats.tombstonesDrained).toBe(2);
    expect(stats.bytesReclaimed).toBe(0);
  });

  test("if drainBlobReadyZero throws, Phase B is NOT run; iteration rejects", async () => {
    // The Phase A drain catches `has()` throws as transient (it explicitly
    // tolerates backend outage). To make the drain ITSELF throw — simulating
    // a harder failure class like a DB error — we wrap the blobStore so
    // `has` returns a falsy-looking value that the drain's subsequent
    // DB operation rejects on. Simplest concrete channel: inject via
    // `__testIteration` replacement is cheating (it bypasses real wiring),
    // so instead we close the second db statement mid-flight.
    //
    // Approach: stub Phase A via a separate test iteration that composes
    // `drainBlobReadyZero` against a DB whose query handle throws. We
    // construct a "poisoned" Database-like wrapper that throws on the
    // Phase A SELECT but is otherwise a real DB.
    const realDb = makeDb();
    const blobDir = makeBlobDir();
    const fs = createFilesystemBlobStore(blobDir);

    // Seed a row Phase A would see (but the SELECT will throw).
    insertBlobReadyZero(realDb, { id: "art_x", hash: "a".repeat(64) });
    // Seed a tombstone Phase B would drain if it ran.
    const hOrphan = await fs.put(new TextEncoder().encode("orphan"));
    realDb
      .query("INSERT INTO pending_blob_deletes (hash, enqueued_at, claimed_at) VALUES (?, ?, NULL)")
      .run(hOrphan, Date.now());

    // Poisoned DB: proxy that forwards everything EXCEPT a SELECT against
    // the artifacts table, which throws. The drain's very first query is
    // that SELECT — so drainBlobReadyZero rejects immediately.
    const poisoned = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (sql: string): unknown => {
            if (sql.includes("FROM artifacts WHERE blob_ready = 0")) {
              throw new Error("drain-level failure");
            }
            return target.query(sql);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Database;

    let deleteCalls = 0;
    const blobStore: BlobStore = {
      put: fs.put,
      get: fs.get,
      has: fs.has,
      delete: async (h) => {
        deleteCalls++;
        return fs.delete(h);
      },
      list: () => fs.list(),
    };

    const w = track(
      createRepairWorker({
        db: poisoned,
        blobStore,
        config: { ...baseConfig, workerIntervalMs: "manual" },
        maxRepairAttempts: 10,
      }),
    );

    await expect(w.runOnce()).rejects.toThrow(/drain-level failure/);
    // Phase B never ran — orphan tombstone untouched, delete never called.
    expect(deleteCalls).toBe(0);
    const row = realDb
      .query("SELECT hash, claimed_at FROM pending_blob_deletes WHERE hash = ?")
      .get(hOrphan) as { readonly hash: string; readonly claimed_at: number | null } | null;
    expect(row).not.toBeNull();
    expect(row?.claimed_at).toBeNull();
  });

  test("worker swallows scheduled-iteration throw; next iteration starts fresh", async () => {
    // The interval path must not leak a rejected Promise — the "start
    // iteration does not crash loop" guarantee from Task 3 must still hold
    // once the body is wired. A Phase A throw must be swallowed so the
    // timer keeps firing.
    const realDb = makeDb();
    const blobDir = makeBlobDir();
    const fs = createFilesystemBlobStore(blobDir);
    insertBlobReadyZero(realDb, { id: "art_y", hash: "b".repeat(64) });

    let phaseASelectCount = 0;
    const poisoned = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (sql: string): unknown => {
            if (sql.includes("FROM artifacts WHERE blob_ready = 0")) {
              phaseASelectCount++;
              throw new Error("boom");
            }
            return target.query(sql);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Database;

    const originalWarn = console.warn;
    console.warn = (): void => {};
    try {
      const w = track(
        createRepairWorker({
          db: poisoned,
          blobStore: fs,
          config: { ...baseConfig, workerIntervalMs: 50 },
          maxRepairAttempts: 10,
        }),
      );
      w.start();
      await new Promise<void>((r) => setTimeout(r, 180));
      // At least two scheduled ticks fired despite each iteration rejecting.
      expect(phaseASelectCount).toBeGreaterThanOrEqual(2);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("transient Phase B failure does not crash iteration; tombstone retained", async () => {
    // Phase B tolerates blobStore.delete throwing: claimed_at stays set for
    // next drain's resume-from-claimed path. Iteration still resolves.
    // drainPendingBlobDeletes does NOT surface transient Phase B count in
    // its return shape ({ reclaimed }) — the worker's `transientErrors`
    // reflects Phase A only, per spec. tombstonesDrained stays 0 for a
    // tombstone whose delete threw.
    const db = makeDb();
    const blobDir = makeBlobDir();
    const fs = createFilesystemBlobStore(blobDir);

    const hOrphan = await fs.put(new TextEncoder().encode("orphan"));
    db.query(
      "INSERT INTO pending_blob_deletes (hash, enqueued_at, claimed_at) VALUES (?, ?, NULL)",
    ).run(hOrphan, Date.now());

    const blobStore: BlobStore = {
      put: fs.put,
      get: fs.get,
      has: fs.has,
      delete: async () => {
        throw new Error("S3 timeout");
      },
      list: () => fs.list(),
    };

    const w = track(
      createRepairWorker({
        db,
        blobStore,
        config: { ...baseConfig, workerIntervalMs: "manual" },
        maxRepairAttempts: 10,
      }),
    );
    const stats = await w.runOnce();

    // No Phase A work; Phase B threw but was caught — iteration succeeds.
    expect(stats.promoted).toBe(0);
    expect(stats.terminallyDeleted).toBe(0);
    expect(stats.transientErrors).toBe(0); // Phase B transients not tracked in WorkerStats
    expect(stats.tombstonesDrained).toBe(0); // reconcile never ran
    // Tombstone retained with claimed_at set so next drain resumes.
    const row = db
      .query("SELECT hash, claimed_at FROM pending_blob_deletes WHERE hash = ?")
      .get(hOrphan) as { readonly hash: string; readonly claimed_at: number | null } | null;
    expect(row).not.toBeNull();
    expect(row?.claimed_at).not.toBeNull();
  });
});

describe("createArtifactStore — workerIntervalMs validation", () => {
  // Validation lives in create-store.ts (mirrors maxRepairAttempts pattern).
  // These tests exercise it through the store factory.
  test.each([
    { value: 0, label: "zero" },
    { value: 50, label: "below floor" },
    { value: -1, label: "negative" },
    { value: 1.5, label: "fractional" },
    { value: Number.NaN, label: "NaN" },
    { value: Number.POSITIVE_INFINITY, label: "Infinity" },
    { value: "auto", label: "unknown string" },
  ])("rejects invalid workerIntervalMs: $label", async ({ value }) => {
    const { mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createArtifactStore } = await import("../create-store.js");
    const blobDir = join(tmpdir(), `koi-art-worker-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    const dbPath = join(blobDir, "store.db");
    try {
      await expect(
        createArtifactStore({
          dbPath,
          blobDir,
          // Smuggle the invalid value through — ArtifactStoreConfig's type
          // forbids it, but runtime validation must still reject.
          workerIntervalMs: value as unknown as number,
        } as unknown as ArtifactStoreConfig),
      ).rejects.toThrow(/workerIntervalMs/);
    } finally {
      rmSync(blobDir, { recursive: true, force: true });
    }
  });
});
