import { describe, expect, test } from "bun:test";
import { createInMemoryCheckpointStore } from "./composition-checkpoint-store.js";

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
    cyclic["self"] = cyclic;
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
});
