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

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BlobStore } from "@koi/blob-cas";
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

  test("start → runOnce returns zero stats", async () => {
    const w = track(
      createRepairWorker({
        db: stubDb,
        blobStore: stubBlobStore,
        config: { ...baseConfig, workerIntervalMs: "manual" },
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
