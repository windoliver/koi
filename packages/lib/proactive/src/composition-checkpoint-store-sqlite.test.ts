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

function listSync(store: CompositionCheckpointStore): readonly CheckpointSnapshot[] {
  // Contract makes list() optional for backward compatibility; the SQLite
  // backend always implements it, so a missing implementation is a bug.
  if (store.list === undefined) {
    throw new Error("sqlite store unexpectedly omitted list()");
  }
  const result = store.list();
  if (result instanceof Promise) {
    throw new Error("sqlite list unexpectedly returned a Promise");
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
    cyclic.self = cyclic;

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

  test("list returns every stored snapshot decoded; empty before any save", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db);
    expect(listSync(store)).toEqual([]);

    store.save(snapshot({ executionId: "a", nextStepIndex: 1, stepResults: ["x"] }));
    store.save(
      snapshot({
        executionId: "b",
        nextStepIndex: 0,
        stepResults: [],
        phase: "failed",
        savedAt: 2_000,
      }),
    );

    const all = listSync(store);
    const ids = all.map((s) => s.executionId).sort();
    expect(ids).toEqual(["a", "b"]);
    const byId = new Map(all.map((s) => [s.executionId, s]));
    expect(byId.get("a")?.stepResults).toEqual(["x"]);
    expect(byId.get("b")?.phase).toBe("failed");
  });

  test("load returns undefined on corrupt step_results JSON (no throw)", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db);
    store.save(snapshot());
    // Corrupt the persisted row directly to simulate manual repair / drift.
    db.prepare("UPDATE composition_checkpoint SET step_results = ? WHERE execution_id = ?").run(
      "{not-json",
      "exec-1",
    );
    expect(loadSync(store, "exec-1")).toBeUndefined();
  });

  test("load returns undefined when stored length disagrees with nextStepIndex", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db);
    store.save(snapshot());
    // Persist a length-mismatched row to simulate post-write tampering.
    db.prepare(
      "UPDATE composition_checkpoint SET step_results = ?, next_step_index = ? WHERE execution_id = ?",
    ).run("[]", "1", "exec-1");
    expect(loadSync(store, "exec-1")).toBeUndefined();
  });

  test("onCorruptRow surfaces decode failures from list() — corrupt rows are not silently lost", () => {
    const db = new Database(":memory:");
    const corrupt: { executionId: string | undefined; reason: string }[] = [];
    const store = sqliteCompositionCheckpointStore(db, {
      onCorruptRow: (record) => {
        corrupt.push({ executionId: record.executionId, reason: record.reason });
      },
    });
    store.save(snapshot({ executionId: "good" }));
    store.save(snapshot({ executionId: "bad" }));
    db.prepare("UPDATE composition_checkpoint SET step_results = ? WHERE execution_id = ?").run(
      "{broken",
      "bad",
    );
    const all = listSync(store);
    expect(all.map((s) => s.executionId)).toEqual(["good"]);
    // "bad" must be reported so a restart watchdog does not silently lose it.
    expect(corrupt.length).toBeGreaterThan(0);
    expect(corrupt.find((c) => c.executionId === "bad")).toBeDefined();
  });

  test("onCorruptRow surfaces decode failures from load() too", () => {
    const db = new Database(":memory:");
    const corrupt: { executionId: string | undefined; reason: string }[] = [];
    const store = sqliteCompositionCheckpointStore(db, {
      onCorruptRow: (record) => {
        corrupt.push({ executionId: record.executionId, reason: record.reason });
      },
    });
    store.save(snapshot());
    db.prepare("UPDATE composition_checkpoint SET step_results = ? WHERE execution_id = ?").run(
      "{not-json",
      "exec-1",
    );
    expect(loadSync(store, "exec-1")).toBeUndefined();
    expect(corrupt.find((c) => c.executionId === "exec-1")).toBeDefined();
  });

  test("a throwing onCorruptRow callback does not break recovery", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db, {
      onCorruptRow: () => {
        throw new Error("callback boom");
      },
    });
    store.save(snapshot({ executionId: "good" }));
    store.save(snapshot({ executionId: "bad" }));
    db.prepare("UPDATE composition_checkpoint SET step_results = ? WHERE execution_id = ?").run(
      "{broken",
      "bad",
    );
    // The good row must still come back despite the faulty diagnostics callback.
    const all = listSync(store);
    expect(all.map((s) => s.executionId)).toEqual(["good"]);
  });

  test("seq guard: stale save (seq <= stored) is dropped", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db);
    store.save(snapshot({ nextStepIndex: 1, stepResults: ["a"], seq: 5 }));
    // Stale write — should be silently dropped at the SQL level.
    store.save(
      snapshot({
        nextStepIndex: 0,
        stepResults: [],
        phase: "failed",
        savedAt: 999,
        seq: 3,
      }),
    );
    const loaded = loadSync(store, "exec-1");
    expect(loaded?.phase).toBe("in_progress");
    expect(loaded?.nextStepIndex).toBe(1);
  });

  test(
    "seq guard: versioned delete leaves a tombstone — late save with " +
      "older seq cannot resurrect",
    () => {
      const db = new Database(":memory:");
      const store = sqliteCompositionCheckpointStore(db);
      store.save(snapshot({ nextStepIndex: 1, stepResults: ["x"], seq: 5 }));
      // Versioned delete: carries the seq into the tombstone.
      store.delete("exec-1", 5);
      expect(loadSync(store, "exec-1")).toBeUndefined();
      // Late write at older seq must not recreate the execution.
      store.save(snapshot({ nextStepIndex: 1, stepResults: ["LATE"], seq: 4 }));
      expect(loadSync(store, "exec-1")).toBeUndefined();
    },
  );

  test(
    "unversioned delete is physical (NOT tombstone) — later unversioned save " +
      "for the same executionId still succeeds",
    () => {
      const db = new Database(":memory:");
      const store = sqliteCompositionCheckpointStore(db);
      // Pure legacy round-trip: save, delete (no seq), save again — must
      // recreate the row. Pre-fix the legacy delete tombstoned the row,
      // and the unversioned UPSERT was filtered by tombstone=0 → silent
      // black hole, recovery state permanently disappeared.
      store.save(snapshot({ nextStepIndex: 1, stepResults: ["first"] }));
      store.delete("exec-1");
      expect(loadSync(store, "exec-1")).toBeUndefined();
      store.save(snapshot({ nextStepIndex: 1, stepResults: ["second"] }));
      expect(loadSync(store, "exec-1")?.stepResults).toEqual(["second"]);
    },
  );

  test(
    "legacy row with seq=NULL migrates cleanly: versioned delete sets watermark, " +
      "versioned save can advance it",
    () => {
      const db = new Database(":memory:");
      const store = sqliteCompositionCheckpointStore(db);
      // Simulate a legacy row written before the seq column existed —
      // direct INSERT bypasses the store API.
      db.prepare(
        "INSERT INTO composition_checkpoint " +
          "(execution_id, plan_hash, next_step_index, step_results, phase, saved_at, seq, tombstone) " +
          "VALUES ('legacy', 'h', 1, '[1]', 'in_progress', 100, NULL, 0)",
      ).run();
      // Versioned delete on the legacy row must set seq from NULL → 50,
      // not leave it NULL (which would brick all future writes).
      store.delete("legacy", 50);
      // Versioned save with seq > 50 must succeed.
      store.save(snapshot({ executionId: "legacy", stepResults: ["NEW"], seq: 60 }));
      const loaded = loadSync(store, "legacy");
      expect(loaded?.stepResults).toEqual(["NEW"]);
      expect(loaded?.seq).toBe(60);
    },
  );

  test(
    "seq-versioned delete UPSERTs a tombstone even when no row exists, " +
      "so a delayed save with older seq cannot resurrect",
    () => {
      const db = new Database(":memory:");
      const store = sqliteCompositionCheckpointStore(db);
      // Simulate the timeout race: terminal delete fires BEFORE any save
      // has reached the backend. With UPDATE-only delete this is a no-op
      // and a delayed save then succeeds — resurrecting an execution that
      // the executor considers finished.
      store.delete("exec-1", 10);
      // Delayed save arriving AFTER the tombstone, with an older seq.
      store.save(snapshot({ stepResults: ["LATE"], seq: 5 }));
      expect(loadSync(store, "exec-1")).toBeUndefined();
      // Even a save with a newer seq cannot resurrect with seq <= tombstone.
      store.save(snapshot({ stepResults: ["NOPE"], seq: 10 }));
      expect(loadSync(store, "exec-1")).toBeUndefined();
      // Strictly-newer seq DOES lift the tombstone (terminal delete is not
      // permanent — the same executionId can be re-used by an explicit
      // restart with a fresh seq).
      store.save(snapshot({ stepResults: ["NEW"], seq: 11 }));
      expect(loadSync(store, "exec-1")?.stepResults).toEqual(["NEW"]);
    },
  );

  test("seq guard: strictly-newer save after delete lifts the tombstone", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db);
    store.save(snapshot({ nextStepIndex: 1, stepResults: ["x"], seq: 5 }));
    store.delete("exec-1");
    store.save(
      snapshot({
        nextStepIndex: 1,
        stepResults: ["NEW"],
        savedAt: 9_999,
        seq: 6,
      }),
    );
    const loaded = loadSync(store, "exec-1");
    expect(loaded?.stepResults).toEqual(["NEW"]);
    expect(loaded?.seq).toBe(6);
  });

  test(
    "mixed-version writers: unversioned save() cannot resurrect a tombstoned " +
      "execution written by versioned delete(id, seq)",
    () => {
      const db = new Database(":memory:");
      const store = sqliteCompositionCheckpointStore(db);
      // Versioned writer finishes execution and tombstones with seq=10.
      store.save(snapshot({ stepResults: ["committed"], seq: 5 }));
      store.delete("exec-1", 10);
      expect(loadSync(store, "exec-1")).toBeUndefined();
      // Older caller in a rolling deploy calls save() WITHOUT a seq. Pre-fix
      // this overwrote the tombstone via `tombstone = 0` in the unguarded
      // UPSERT, resurrecting the execution. Post-fix the UPDATE is filtered
      // by `WHERE tombstone = 0 AND seq IS NULL`.
      store.save(snapshot({ stepResults: ["RESURRECTED"] }));
      expect(loadSync(store, "exec-1")).toBeUndefined();
    },
  );

  test(
    "mixed-version writers: unversioned save() cannot overwrite a row " +
      "claimed by a versioned writer (non-null seq)",
    () => {
      const db = new Database(":memory:");
      const store = sqliteCompositionCheckpointStore(db);
      // Versioned writer holds the row at seq=7.
      store.save(snapshot({ stepResults: ["versioned"], seq: 7 }));
      // Legacy caller tries to overwrite without a seq → must be filtered.
      store.save(snapshot({ stepResults: ["legacy-clobber"] }));
      const loaded = loadSync(store, "exec-1");
      expect(loaded?.stepResults).toEqual(["versioned"]);
      expect(loaded?.seq).toBe(7);
    },
  );

  test("unversioned save() still works on a pure legacy row (seq IS NULL, no tombstone)", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db);
    // Direct INSERT to simulate a row written before the seq column existed.
    db.prepare(
      "INSERT INTO composition_checkpoint " +
        "(execution_id, plan_hash, next_step_index, step_results, phase, saved_at, seq, tombstone) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL, 0)",
    ).run("exec-1", "h0", 0, "[]", "in_progress", 1_000);
    // Legacy save() must still UPSERT this row (back-compat).
    store.save(snapshot({ stepResults: ["legacy-update"], savedAt: 2_000 }));
    expect(loadSync(store, "exec-1")?.stepResults).toEqual(["legacy-update"]);
  });

  test("list skips corrupt rows instead of throwing", () => {
    const db = new Database(":memory:");
    const store = sqliteCompositionCheckpointStore(db);
    store.save(snapshot({ executionId: "good" }));
    store.save(snapshot({ executionId: "bad" }));
    db.prepare("UPDATE composition_checkpoint SET step_results = ? WHERE execution_id = ?").run(
      "{broken",
      "bad",
    );
    const all = listSync(store);
    expect(all.map((s) => s.executionId)).toEqual(["good"]);
  });
});
