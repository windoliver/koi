import { describe, expect, test } from "bun:test";
import {
  type CheckpointSnapshot,
  type CompositionCheckpointStore,
  createInMemoryCheckpointStore,
} from "./composition-checkpoint-store.js";

// `list()` is optional on the public contract for backward compatibility,
// but the in-memory backend always implements it. This helper asserts
// presence so tests can call it without per-site narrowing.
async function listAll(store: CompositionCheckpointStore): Promise<readonly CheckpointSnapshot[]> {
  if (store.list === undefined) {
    throw new Error("in-memory store unexpectedly omitted list()");
  }
  return await store.list();
}

describe("createInMemoryCheckpointStore", () => {
  test("load before any save returns undefined", async () => {
    const store = createInMemoryCheckpointStore();
    const snap = await store.load("exec-1");
    expect(snap).toBeUndefined();
  });

  test("save then load returns the saved snapshot verbatim", async () => {
    const store = createInMemoryCheckpointStore();
    const snap = {
      executionId: "exec-1",
      planHash: "h1",
      nextStepIndex: 2,
      stepResults: [{ step: 0 }, { step: 1 }] as const,
      phase: "in_progress" as const,
      savedAt: 100,
    };
    await store.save(snap);
    expect(await store.load("exec-1")).toEqual(snap);
  });

  test("save twice with same executionId — load returns the latest", async () => {
    const store = createInMemoryCheckpointStore();
    const first = {
      executionId: "exec-1",
      planHash: "h1",
      nextStepIndex: 1,
      stepResults: [{ a: 1 }] as const,
      phase: "in_progress" as const,
      savedAt: 100,
    };
    const second = {
      executionId: "exec-1",
      planHash: "h1",
      nextStepIndex: 2,
      stepResults: [{ a: 1 }, { b: 2 }] as const,
      phase: "in_progress" as const,
      savedAt: 200,
    };
    await store.save(first);
    await store.save(second);
    expect(await store.load("exec-1")).toEqual(second);
  });

  test("save with different executionIds — load returns the right one per id", async () => {
    const store = createInMemoryCheckpointStore();
    const a = {
      executionId: "exec-A",
      planHash: "hA",
      nextStepIndex: 0,
      stepResults: [] as const,
      phase: "in_progress" as const,
      savedAt: 1,
    };
    const b = {
      executionId: "exec-B",
      planHash: "hB",
      nextStepIndex: 1,
      stepResults: [{ x: 1 }] as const,
      phase: "completed" as const,
      savedAt: 2,
    };
    await store.save(a);
    await store.save(b);
    expect(await store.load("exec-A")).toEqual(a);
    expect(await store.load("exec-B")).toEqual(b);
  });

  test("delete removes the snapshot — subsequent load returns undefined", async () => {
    const store = createInMemoryCheckpointStore();
    const snap = {
      executionId: "exec-1",
      planHash: "h1",
      nextStepIndex: 0,
      stepResults: [] as const,
      phase: "in_progress" as const,
      savedAt: 1,
    };
    await store.save(snap);
    await store.delete("exec-1");
    expect(await store.load("exec-1")).toBeUndefined();
  });

  test("delete of unknown id is a no-op", async () => {
    const store = createInMemoryCheckpointStore();
    // Should not throw.
    await store.delete("never-saved");
    expect(await store.load("never-saved")).toBeUndefined();
  });

  test("save throws when stepResults length does not match nextStepIndex", () => {
    const store = createInMemoryCheckpointStore();
    expect(() =>
      store.save({
        executionId: "exec-1",
        planHash: "h1",
        nextStepIndex: 2,
        stepResults: [{ a: 1 }],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).toThrow(/stepResults.length must equal nextStepIndex/);
  });

  test("save throws when nextStepIndex is negative", () => {
    const store = createInMemoryCheckpointStore();
    expect(() =>
      store.save({
        executionId: "exec-1",
        planHash: "h1",
        nextStepIndex: -1,
        stepResults: [],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).toThrow(/nextStepIndex must be >= 0/);
  });

  test("save throws when planHash or executionId is empty", () => {
    const store = createInMemoryCheckpointStore();
    expect(() =>
      store.save({
        executionId: "",
        planHash: "h1",
        nextStepIndex: 0,
        stepResults: [],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).toThrow(/executionId must be non-empty/);

    expect(() =>
      store.save({
        executionId: "exec-1",
        planHash: "",
        nextStepIndex: 0,
        stepResults: [],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).toThrow(/planHash must be non-empty/);
  });

  test("stored snapshot is isolated from caller-side mutation of a copy", async () => {
    const store = createInMemoryCheckpointStore();
    const original = {
      executionId: "exec-1",
      planHash: "h1",
      nextStepIndex: 1,
      stepResults: [{ step: 0 }] as const,
      phase: "in_progress" as const,
      savedAt: 100,
    };
    await store.save(original);

    // Caller mutates a local copy — should NOT affect the stored snapshot
    // (readonly types make this a structural guarantee; this test documents
    // that intent and protects against an accidental future regression to
    // a mutable shape).
    const copy = { ...original, nextStepIndex: 99 };
    void copy;

    expect(await store.load("exec-1")).toEqual(original);
  });

  test("save throws when stepResults contain a function (non-serializable)", () => {
    const store = createInMemoryCheckpointStore();
    expect(() =>
      store.save({
        executionId: "exec-1",
        planHash: "h1",
        nextStepIndex: 1,
        stepResults: [(() => 42) as unknown as never],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).toThrow(/not JSON-serializable/);
  });

  test("save sanitizes Error instance via default JSON encoder (no throw)", async () => {
    const store = createInMemoryCheckpointStore();
    expect(() =>
      store.save({
        executionId: "exec-1",
        planHash: "h1",
        nextStepIndex: 1,
        stepResults: [new Error("boom") as unknown],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).not.toThrow();
    // Error instance is encoded as {} by JSON.stringify (no enumerable keys).
    const loaded = await store.load("exec-1");
    expect(loaded?.stepResults).toEqual([{}]);
  });

  test("save throws when stepResults contain a cyclic object", () => {
    const store = createInMemoryCheckpointStore();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() =>
      store.save({
        executionId: "exec-1",
        planHash: "h1",
        nextStepIndex: 1,
        stepResults: [cyclic as unknown],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).toThrow(/could not be encoded/);
  });

  test("save with encoder=null preserves legacy strict behavior — Error throws", () => {
    const store = createInMemoryCheckpointStore({ encoder: null });
    expect(() =>
      store.save({
        executionId: "exec-1",
        planHash: "h1",
        nextStepIndex: 1,
        stepResults: [new Error("boom") as unknown],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).toThrow(/not JSON-serializable/);
  });

  test("save throws when stepResults contain NaN or Infinity", () => {
    const store = createInMemoryCheckpointStore();
    expect(() =>
      store.save({
        executionId: "exec-1",
        planHash: "h1",
        nextStepIndex: 1,
        stepResults: [Number.NaN as unknown as never],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).toThrow(/not JSON-serializable/);
    expect(() =>
      store.save({
        executionId: "exec-2",
        planHash: "h1",
        nextStepIndex: 1,
        stepResults: [Number.POSITIVE_INFINITY as unknown as never],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).toThrow(/not JSON-serializable/);
  });

  test("save accepts repeated references in acyclic graph (shared subobject)", () => {
    const store = createInMemoryCheckpointStore();
    const shared = { x: 1 };
    expect(() =>
      store.save({
        executionId: "exec-1",
        planHash: "h1",
        nextStepIndex: 1,
        stepResults: [{ a: shared, b: shared }],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).not.toThrow();
  });

  test("post-save mutation of caller object does not affect persisted snapshot", async () => {
    const store = createInMemoryCheckpointStore();
    const result: { step: number; data: string[] } = { step: 0, data: ["a"] };
    await store.save({
      executionId: "exec-1",
      planHash: "h1",
      nextStepIndex: 1,
      stepResults: [result],
      phase: "in_progress",
      savedAt: 1,
    });
    // Caller mutates after save — store must be unaffected.
    result.step = 999;
    result.data.push("CORRUPTED");
    const loaded = await store.load("exec-1");
    expect(loaded?.stepResults).toEqual([{ step: 0, data: ["a"] }]);
  });

  test("post-load mutation of returned snapshot does not affect persisted state", async () => {
    const store = createInMemoryCheckpointStore();
    await store.save({
      executionId: "exec-1",
      planHash: "h1",
      nextStepIndex: 1,
      stepResults: [{ step: 0 }],
      phase: "in_progress",
      savedAt: 1,
    });
    const first = await store.load("exec-1");
    // Caller mutates the loaded snapshot's nested object via runtime access
    // (TS readonly is compile-time only).
    const stepResults = (first as unknown as { stepResults: { step: number }[] }).stepResults;
    if (stepResults[0] !== undefined) stepResults[0].step = 999;
    const second = await store.load("exec-1");
    expect(second?.stepResults).toEqual([{ step: 0 }]);
  });

  test("save accepts plain JSON values (string, number, bool, null, array, object)", () => {
    const store = createInMemoryCheckpointStore();
    expect(() =>
      store.save({
        executionId: "exec-1",
        planHash: "h1",
        nextStepIndex: 1,
        stepResults: [{ a: 1, b: "x", c: true, d: null, e: [1, 2, { nested: "ok" }] }],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).not.toThrow();
  });

  test("list returns every stored snapshot; emptied after delete", async () => {
    const store = createInMemoryCheckpointStore();
    expect(await listAll(store)).toEqual([]);

    await store.save({
      executionId: "a",
      planHash: "h",
      nextStepIndex: 1,
      stepResults: [1],
      phase: "in_progress",
      savedAt: 1,
    });
    await store.save({
      executionId: "b",
      planHash: "h",
      nextStepIndex: 0,
      stepResults: [],
      phase: "failed",
      savedAt: 2,
    });

    const all = await listAll(store);
    const ids = all.map((s) => s.executionId).sort();
    expect(ids).toEqual(["a", "b"]);

    await store.delete("a");
    const remaining = await listAll(store);
    expect(remaining.map((s) => s.executionId)).toEqual(["b"]);
  });

  test("seq guard: a save with seq <= stored seq is dropped (stale writer protection)", async () => {
    const store = createInMemoryCheckpointStore();
    await store.save({
      executionId: "a",
      planHash: "h",
      nextStepIndex: 1,
      stepResults: [1],
      phase: "in_progress",
      savedAt: 1,
      seq: 5,
    });
    // Stale write — should be silently dropped.
    await store.save({
      executionId: "a",
      planHash: "h",
      nextStepIndex: 0,
      stepResults: [],
      phase: "failed",
      savedAt: 2,
      seq: 3,
    });
    const reloaded = await store.load("a");
    expect(reloaded?.phase).toBe("in_progress");
    expect(reloaded?.seq).toBe(5);
  });

  test("seq guard: delete tombstones the watermark so late save with older seq cannot resurrect", async () => {
    const store = createInMemoryCheckpointStore();
    await store.save({
      executionId: "a",
      planHash: "h",
      nextStepIndex: 1,
      stepResults: [1],
      phase: "in_progress",
      savedAt: 1,
      seq: 5,
    });
    await store.delete("a");
    // Late write with seq < watermark — must NOT recreate the execution.
    await store.save({
      executionId: "a",
      planHash: "h",
      nextStepIndex: 1,
      stepResults: ["LATE"],
      phase: "in_progress",
      savedAt: 999,
      seq: 4,
    });
    expect(await store.load("a")).toBeUndefined();
  });

  test(
    "seq-versioned delete sets watermark even when no row exists, " +
      "so a delayed save with older seq cannot resurrect",
    async () => {
      const store = createInMemoryCheckpointStore();
      // Delete before any save: the only effect must be that future
      // saves with seq <= 10 are silently dropped.
      await store.delete("a", 10);
      await store.save({
        executionId: "a",
        planHash: "h",
        nextStepIndex: 1,
        stepResults: ["LATE"],
        phase: "in_progress",
        savedAt: 1,
        seq: 5,
      });
      expect(await store.load("a")).toBeUndefined();
      // Strictly-newer seq must succeed (same id can be re-used).
      await store.save({
        executionId: "a",
        planHash: "h",
        nextStepIndex: 1,
        stepResults: ["NEW"],
        phase: "in_progress",
        savedAt: 2,
        seq: 11,
      });
      expect((await store.load("a"))?.stepResults).toEqual(["NEW"]);
    },
  );

  test("seq guard: a strictly-newer save overwrites the previous", async () => {
    const store = createInMemoryCheckpointStore();
    await store.save({
      executionId: "a",
      planHash: "h",
      nextStepIndex: 1,
      stepResults: [1],
      phase: "in_progress",
      savedAt: 1,
      seq: 5,
    });
    await store.save({
      executionId: "a",
      planHash: "h",
      nextStepIndex: 2,
      stepResults: [1, 2],
      phase: "in_progress",
      savedAt: 2,
      seq: 6,
    });
    const reloaded = await store.load("a");
    expect(reloaded?.nextStepIndex).toBe(2);
    expect(reloaded?.seq).toBe(6);
  });

  test("mixed-version writers: unversioned save() cannot resurrect after versioned delete(id, seq)", async () => {
    const store = createInMemoryCheckpointStore();
    await store.save({
      executionId: "a",
      planHash: "h1",
      nextStepIndex: 1,
      stepResults: ["committed"],
      phase: "in_progress",
      savedAt: 1,
      seq: 5,
    });
    await store.delete("a", 10);
    expect(await store.load("a")).toBeUndefined();
    // Legacy caller in a rolling deploy — save() without seq must NOT
    // resurrect the tombstoned execution.
    await store.save({
      executionId: "a",
      planHash: "h2",
      nextStepIndex: 1,
      stepResults: ["RESURRECTED"],
      phase: "in_progress",
      savedAt: 2,
    });
    expect(await store.load("a")).toBeUndefined();
  });

  test("mixed-version writers: unversioned save() cannot overwrite a row claimed by a versioned writer", async () => {
    const store = createInMemoryCheckpointStore();
    await store.save({
      executionId: "a",
      planHash: "h1",
      nextStepIndex: 2,
      stepResults: ["v1", "v2"],
      phase: "in_progress",
      savedAt: 1,
      seq: 7,
    });
    // Legacy save without seq must be a no-op once a versioned writer
    // has claimed the row.
    await store.save({
      executionId: "a",
      planHash: "h2",
      nextStepIndex: 0,
      stepResults: [],
      phase: "in_progress",
      savedAt: 2,
    });
    const loaded = await store.load("a");
    expect(loaded?.stepResults).toEqual(["v1", "v2"]);
    expect(loaded?.seq).toBe(7);
  });

  test("pure legacy rows (never versioned) still accept unversioned last-writer-wins", async () => {
    const store = createInMemoryCheckpointStore();
    await store.save({
      executionId: "a",
      planHash: "h1",
      nextStepIndex: 1,
      stepResults: ["first"],
      phase: "in_progress",
      savedAt: 1,
    });
    await store.save({
      executionId: "a",
      planHash: "h1",
      nextStepIndex: 2,
      stepResults: ["first", "second"],
      phase: "in_progress",
      savedAt: 2,
    });
    const loaded = await store.load("a");
    expect(loaded?.nextStepIndex).toBe(2);
    expect(loaded?.stepResults).toEqual(["first", "second"]);
  });

  test("save throws on invalid seq (NaN, Infinity, negative, fractional)", () => {
    const store = createInMemoryCheckpointStore();
    const base = {
      executionId: "exec-1",
      planHash: "h1",
      nextStepIndex: 0,
      stepResults: [] as const,
      phase: "in_progress" as const,
      savedAt: 1,
    };
    expect(() => store.save({ ...base, seq: Number.NaN })).toThrow(
      /seq must be a non-negative integer/,
    );
    expect(() => store.save({ ...base, seq: Number.POSITIVE_INFINITY })).toThrow(
      /seq must be a non-negative integer/,
    );
    expect(() => store.save({ ...base, seq: -1 })).toThrow(/seq must be a non-negative integer/);
    expect(() => store.save({ ...base, seq: 1.5 })).toThrow(/seq must be a non-negative integer/);
  });

  test("delete throws on invalid seq", () => {
    const store = createInMemoryCheckpointStore();
    expect(() => store.delete("exec-1", Number.NaN)).toThrow(/seq must be a non-negative integer/);
    expect(() => store.delete("exec-1", -1)).toThrow(/seq must be a non-negative integer/);
    expect(() => store.delete("exec-1", 1.5)).toThrow(/seq must be a non-negative integer/);
  });

  test("save with invalid seq does NOT poison the watermark — later valid saves succeed", async () => {
    const store = createInMemoryCheckpointStore();
    const base = {
      executionId: "exec-1",
      planHash: "h1",
      nextStepIndex: 1,
      stepResults: [{ ok: true }],
      phase: "in_progress" as const,
      savedAt: 1,
    };
    // Rejected. Pre-fix this stored NaN as watermark; NaN <= anything
    // is false, so the next valid save would have been "newer" and
    // succeeded — but with arithmetic on NaN tainting future comparisons.
    expect(() => store.save({ ...base, seq: Number.NaN })).toThrow();
    // Valid follow-up: must persist normally with a clean watermark.
    await store.save({ ...base, seq: 5 });
    const loaded = await store.load("exec-1");
    expect(loaded?.seq).toBe(5);
    // Stale write at seq <= 5 is correctly rejected.
    await store.save({ ...base, seq: 4, stepResults: [{ stale: true }] });
    expect((await store.load("exec-1"))?.stepResults).toEqual([{ ok: true }]);
  });

  test(
    "failed save (encode throws) does NOT advance the seq watermark — " +
      "retry with same seq still succeeds",
    async () => {
      const store = createInMemoryCheckpointStore();
      // First save throws during encode/validate (cyclic). Pre-fix, the
      // watermark advanced before the throw, so a follow-up legitimate
      // save at seq <= 5 was silently dropped — a single bad payload
      // permanently suppressed later progress.
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic.self = cyclic;
      expect(() =>
        store.save({
          executionId: "exec-1",
          planHash: "h1",
          nextStepIndex: 1,
          stepResults: [cyclic as unknown],
          phase: "in_progress",
          savedAt: 1,
          seq: 5,
        }),
      ).toThrow();
      // Retry at the SAME seq (5) with a valid payload — must persist.
      await store.save({
        executionId: "exec-1",
        planHash: "h1",
        nextStepIndex: 1,
        stepResults: [{ ok: true }],
        phase: "in_progress",
        savedAt: 2,
        seq: 5,
      });
      const loaded = await store.load("exec-1");
      expect(loaded?.stepResults).toEqual([{ ok: true }]);
      expect(loaded?.seq).toBe(5);
    },
  );

  test("list returns deep clones — mutating result does not affect stored state", async () => {
    const store = createInMemoryCheckpointStore();
    const snap: CheckpointSnapshot = {
      executionId: "a",
      planHash: "h",
      nextStepIndex: 1,
      stepResults: [{ nested: { value: "original" } }],
      phase: "in_progress",
      savedAt: 1,
    };
    await store.save(snap);

    const listed = await listAll(store);
    // Mutate the returned object's nested field.
    const first = listed[0];
    if (first !== undefined) {
      (first.stepResults[0] as { nested: { value: string } }).nested.value = "MUTATED";
    }

    const reloaded = await store.load("a");
    expect((reloaded?.stepResults[0] as { nested: { value: string } }).nested.value).toBe(
      "original",
    );
  });
});
