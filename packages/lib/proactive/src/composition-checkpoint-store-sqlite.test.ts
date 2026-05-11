import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type {
  CheckpointSnapshot,
  CompositionCheckpointStore,
} from "./composition-checkpoint-store.js";
import { sqliteCompositionCheckpointStore } from "./composition-checkpoint-store-sqlite.js";

// The L0 contract types `load` as `T | Promise<T>` so future async backends
// satisfy the same shape; the SQLite backend is always synchronous. This
// helper narrows to the sync arm in tests without an `as` cast.
function loadSync(store: CompositionCheckpointStore, id: string): CheckpointSnapshot | undefined {
  const result = store.load(id);
  if (result instanceof Promise) {
    throw new Error("sqlite load unexpectedly returned a Promise");
  }
  return result;
}

function snapshot(overrides: Partial<CheckpointSnapshot> = {}): CheckpointSnapshot {
  return {
    executionId: "exec-1",
    planHash: "hash-1",
    nextStepIndex: 1,
    stepResults: [{ ok: true }],
    phase: "in_progress",
    savedAt: 1_700_000_000,
    ...overrides,
  };
}

describe("sqliteCompositionCheckpointStore", () => {
  test("save then load round-trips the snapshot", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db);

    store.save(snapshot());
    const loaded = loadSync(store, "exec-1");

    expect(loaded).toEqual({
      executionId: "exec-1",
      planHash: "hash-1",
      nextStepIndex: 1,
      stepResults: [{ ok: true }],
      phase: "in_progress",
      savedAt: 1_700_000_000,
    });
  });

  test("load returns undefined for unknown executionId", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db);

    expect(loadSync(store, "missing")).toBeUndefined();
  });

  test("save UPSERTs on the same executionId", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db);

    store.save(snapshot({ nextStepIndex: 1, stepResults: ["a"] }));
    store.save(
      snapshot({
        nextStepIndex: 2,
        stepResults: ["a", "b"],
        phase: "completed",
        savedAt: 1_700_000_500,
      }),
    );

    const loaded = loadSync(store, "exec-1");
    expect(loaded).toEqual({
      executionId: "exec-1",
      planHash: "hash-1",
      nextStepIndex: 2,
      stepResults: ["a", "b"],
      phase: "completed",
      savedAt: 1_700_000_500,
    });
  });

  test("delete removes the row so load returns undefined", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db);

    store.save(snapshot());
    store.delete("exec-1");

    expect(loadSync(store, "exec-1")).toBeUndefined();
  });

  test("survives across store instances on the same db (restart simulation)", () => {
    const db = new Database(":memory:");
    const s1 = sqliteCompositionCheckpointStore(db);
    s1.save(snapshot({ planHash: "h", nextStepIndex: 2, stepResults: ["x", "y"] }));

    const s2 = sqliteCompositionCheckpointStore(db);
    expect(loadSync(s2, "exec-1")).toEqual({
      executionId: "exec-1",
      planHash: "h",
      nextStepIndex: 2,
      stepResults: ["x", "y"],
      phase: "in_progress",
      savedAt: 1_700_000_000,
    });
  });

  test("encoder sanitizes non-JSON step outputs by default", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db);

    // safeJsonEncoder drops undefined/functions/symbols silently and
    // round-trips Date as ISO string (via Date.prototype.toJSON).
    const date = new Date("2026-05-10T00:00:00.000Z");
    store.save(
      snapshot({
        nextStepIndex: 1,
        stepResults: [{ at: date, dropped: () => 1 }],
      }),
    );
    const loaded = loadSync(store, "exec-1");
    expect(loaded?.stepResults).toEqual([{ at: "2026-05-10T00:00:00.000Z" }]);
  });

  test("encoder failure on non-serializable input is surfaced to caller", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db);

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    expect(() => store.save(snapshot({ stepResults: [cyclic] }))).toThrow(/could not be encoded/u);
  });

  test("rejects invalid table names to prevent SQL injection", () => {
    const db = new Database(":memory:");
    expect(() =>
      sqliteCompositionCheckpointStore(db, { tableName: "drop; DROP TABLE users; --" }),
    ).toThrow(/invalid tableName/u);
  });

  test("validates snapshot invariants synchronously", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db);

    expect(() => store.save(snapshot({ executionId: "" }))).toThrow(/executionId/u);
    expect(() => store.save(snapshot({ planHash: "" }))).toThrow(/planHash/u);
    expect(() => store.save(snapshot({ nextStepIndex: -1 }))).toThrow(/nextStepIndex/u);
    expect(() => store.save(snapshot({ nextStepIndex: 1.5 }))).toThrow(/nextStepIndex/u);
    expect(() => store.save(snapshot({ nextStepIndex: 2, stepResults: ["only-one"] }))).toThrow(
      /stepResults\.length/u,
    );
  });

  test("custom tableName creates and uses the named table", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db, { tableName: "my_checkpoints" });

    store.save(snapshot());
    expect(loadSync(store, "exec-1")?.planHash).toBe("hash-1");
  });

  test("encoder: null opt-out trusts pre-encoded inputs", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db, { encoder: null });

    store.save(snapshot({ stepResults: [{ kind: "complete", n: 7 }] }));
    expect(loadSync(store, "exec-1")?.stepResults).toEqual([{ kind: "complete", n: 7 }]);
  });
});
