import { describe, expect, test } from "bun:test";
import { createSessionState } from "./session-state.js";

describe("createSessionState", () => {
  test("getOrCreate creates on first call, returns existing on second", () => {
    let calls = 0;
    const state = createSessionState(() => {
      calls++;
      return { count: 0 };
    });

    const first = state.getOrCreate("s1");
    expect(first).toEqual({ count: 0 });
    expect(calls).toBe(1);

    const second = state.getOrCreate("s1");
    expect(second).toBe(first); // same reference
    expect(calls).toBe(1); // factory not called again
  });

  test("get returns undefined for missing session", () => {
    const state = createSessionState(() => ({ v: 1 }));
    expect(state.get("missing")).toBeUndefined();
  });

  test("get returns existing state", () => {
    const state = createSessionState(() => ({ v: 1 }));
    const created = state.getOrCreate("s1");
    expect(state.get("s1")).toBe(created);
  });

  test("update applies immutable transformation", () => {
    const state = createSessionState(() => ({ count: 0 }));
    state.getOrCreate("s1");

    state.update("s1", (s) => ({ ...s, count: s.count + 1 }));
    expect(state.get("s1")).toEqual({ count: 1 });

    state.update("s1", (s) => ({ ...s, count: s.count + 5 }));
    expect(state.get("s1")).toEqual({ count: 6 });
  });

  test("update is no-op for missing session", () => {
    const state = createSessionState(() => ({ count: 0 }));
    // Should not throw
    state.update("missing", (s) => ({ ...s, count: 99 }));
    expect(state.get("missing")).toBeUndefined();
  });

  test("delete removes session and returns true", () => {
    const state = createSessionState(() => ({ v: 1 }));
    state.getOrCreate("s1");
    expect(state.delete("s1")).toBe(true);
    expect(state.get("s1")).toBeUndefined();
    expect(state.size).toBe(0);
  });

  test("delete returns false for missing session", () => {
    const state = createSessionState(() => ({ v: 1 }));
    expect(state.delete("missing")).toBe(false);
  });

  test("clear removes all sessions", () => {
    const state = createSessionState(() => ({ v: 1 }));
    state.getOrCreate("s1");
    state.getOrCreate("s2");
    state.getOrCreate("s3");
    expect(state.size).toBe(3);

    state.clear();
    expect(state.size).toBe(0);
    expect(state.get("s1")).toBeUndefined();
    expect(state.get("s2")).toBeUndefined();
    expect(state.get("s3")).toBeUndefined();
  });

  test("size tracks active sessions", () => {
    const state = createSessionState(() => ({}));
    expect(state.size).toBe(0);

    state.getOrCreate("s1");
    expect(state.size).toBe(1);

    state.getOrCreate("s2");
    expect(state.size).toBe(2);

    state.delete("s1");
    expect(state.size).toBe(1);
  });

  test("maxSessions evicts oldest when exceeded", () => {
    const state = createSessionState(() => ({ v: 1 }), { maxSessions: 2 });

    state.getOrCreate("s1");
    state.getOrCreate("s2");
    expect(state.size).toBe(2);

    // Adding s3 should evict s1 (oldest)
    state.getOrCreate("s3");
    expect(state.size).toBe(2);
    expect(state.get("s1")).toBeUndefined();
    expect(state.get("s2")).toEqual({ v: 1 });
    expect(state.get("s3")).toEqual({ v: 1 });
  });

  test("maxSessions calls onEvict callback", () => {
    const evicted: string[] = [];
    const state = createSessionState(() => ({}), {
      maxSessions: 2,
      onEvict: (id) => evicted.push(id),
    });

    state.getOrCreate("s1");
    state.getOrCreate("s2");
    state.getOrCreate("s3"); // evicts s1

    expect(evicted).toEqual(["s1"]);

    state.getOrCreate("s4"); // evicts s2
    expect(evicted).toEqual(["s1", "s2"]);
  });

  test("factory exception propagates to caller", () => {
    const state = createSessionState(() => {
      throw new Error("factory boom");
    });

    expect(() => state.getOrCreate("s1")).toThrow("factory boom");
    // Session should not be stored after failed factory
    expect(state.get("s1")).toBeUndefined();
    expect(state.size).toBe(0);
  });

  test("double getOrCreate is idempotent", () => {
    let calls = 0;
    const state = createSessionState(() => {
      calls++;
      return { id: calls };
    });

    const a = state.getOrCreate("s1");
    const b = state.getOrCreate("s1");
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  test("defaults to maxSessions of 1000", () => {
    const state = createSessionState(() => ({}));
    for (let i = 0; i < 1001; i++) {
      state.getOrCreate(`s${i}`);
    }
    expect(state.size).toBe(1000);
    expect(state.get("s0")).toBeUndefined(); // oldest evicted
    expect(state.get("s1")).toBeDefined();
  });
});
