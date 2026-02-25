import { describe, expect, test } from "bun:test";
import { createRunContextStore } from "./run-context-store.js";

function makeMockWriter(): WritableStreamDefaultWriter<Uint8Array> {
  const stream = new WritableStream<Uint8Array>();
  return stream.getWriter();
}

describe("createRunContextStore", () => {
  test("register and get a writer", () => {
    const store = createRunContextStore();
    const writer = makeMockWriter();
    const ac = new AbortController();

    store.register("run-1", writer, ac.signal);

    expect(store.get("run-1")).toBe(writer);
    expect(store.size).toBe(1);
  });

  test("get returns undefined for unknown runId", () => {
    const store = createRunContextStore();
    expect(store.get("unknown")).toBeUndefined();
  });

  test("deregister removes the entry", () => {
    const store = createRunContextStore();
    const writer = makeMockWriter();
    const ac = new AbortController();

    store.register("run-1", writer, ac.signal);
    store.deregister("run-1");

    expect(store.get("run-1")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test("deregister is idempotent for unknown runId", () => {
    const store = createRunContextStore();
    // Should not throw
    store.deregister("nonexistent");
    expect(store.size).toBe(0);
  });

  test("cleanup on AbortSignal abort", () => {
    const store = createRunContextStore();
    const writer = makeMockWriter();
    const ac = new AbortController();

    store.register("run-1", writer, ac.signal);
    expect(store.size).toBe(1);

    ac.abort();
    // AbortSignal listener fires synchronously
    expect(store.size).toBe(0);
    expect(store.get("run-1")).toBeUndefined();
  });

  test("concurrent runs with distinct runIds are independent", () => {
    const store = createRunContextStore();
    const w1 = makeMockWriter();
    const w2 = makeMockWriter();
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    store.register("run-1", w1, ac1.signal);
    store.register("run-2", w2, ac2.signal);

    expect(store.size).toBe(2);
    expect(store.get("run-1")).toBe(w1);
    expect(store.get("run-2")).toBe(w2);

    // Aborting run-1 does not affect run-2
    ac1.abort();
    expect(store.size).toBe(1);
    expect(store.get("run-1")).toBeUndefined();
    expect(store.get("run-2")).toBe(w2);
  });

  test("duplicate registration for same runId throws", () => {
    const store = createRunContextStore();
    const w1 = makeMockWriter();
    const w2 = makeMockWriter();
    const ac = new AbortController();

    store.register("run-1", w1, ac.signal);

    expect(() => store.register("run-1", w2, ac.signal)).toThrow(
      /duplicate registration for runId/,
    );
    // Original writer is still registered
    expect(store.get("run-1")).toBe(w1);
  });

  test("hasTextStreamed returns false before markTextStreamed", () => {
    const store = createRunContextStore();
    const writer = makeMockWriter();
    const ac = new AbortController();

    store.register("run-1", writer, ac.signal);
    expect(store.hasTextStreamed("run-1")).toBe(false);
  });

  test("markTextStreamed + hasTextStreamed", () => {
    const store = createRunContextStore();
    const writer = makeMockWriter();
    const ac = new AbortController();

    store.register("run-1", writer, ac.signal);
    store.markTextStreamed("run-1");
    expect(store.hasTextStreamed("run-1")).toBe(true);
  });

  test("markTextStreamed is no-op for unregistered runId", () => {
    const store = createRunContextStore();
    // Should not throw
    store.markTextStreamed("nonexistent");
    expect(store.hasTextStreamed("nonexistent")).toBe(false);
  });

  test("hasTextStreamed returns false for unregistered runId", () => {
    const store = createRunContextStore();
    expect(store.hasTextStreamed("nonexistent")).toBe(false);
  });

  test("textStreamed flag is isolated per run", () => {
    const store = createRunContextStore();
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    store.register("run-1", makeMockWriter(), ac1.signal);
    store.register("run-2", makeMockWriter(), ac2.signal);

    store.markTextStreamed("run-1");

    expect(store.hasTextStreamed("run-1")).toBe(true);
    expect(store.hasTextStreamed("run-2")).toBe(false);
  });
});
