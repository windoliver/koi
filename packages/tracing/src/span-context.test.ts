import { describe, expect, test } from "bun:test";
import { createSpanContextStore } from "./span-context.js";

/** Creates a minimal mock Span for testing store operations. */
function mockSpan(id: string): import("@opentelemetry/api").Span {
  return { id, end: () => {} } as unknown as import("@opentelemetry/api").Span;
}

describe("createSpanContextStore", () => {
  test("set and get return the stored span", () => {
    const store = createSpanContextStore();
    const span = mockSpan("s1");

    store.set("key1", span);
    expect(store.get("key1")).toBe(span);
  });

  test("get returns undefined for unknown key", () => {
    const store = createSpanContextStore();
    expect(store.get("unknown")).toBeUndefined();
  });

  test("delete removes the span and returns true", () => {
    const store = createSpanContextStore();
    store.set("key1", mockSpan("s1"));

    expect(store.delete("key1")).toBe(true);
    expect(store.get("key1")).toBeUndefined();
  });

  test("delete returns false for unknown key", () => {
    const store = createSpanContextStore();
    expect(store.delete("unknown")).toBe(false);
  });

  test("size reflects current entry count", () => {
    const store = createSpanContextStore();
    expect(store.size()).toBe(0);

    store.set("k1", mockSpan("s1"));
    store.set("k2", mockSpan("s2"));
    expect(store.size()).toBe(2);

    store.delete("k1");
    expect(store.size()).toBe(1);
  });

  test("evicts oldest entry when maxSize exceeded", () => {
    const store = createSpanContextStore(3);

    store.set("k1", mockSpan("s1"));
    store.set("k2", mockSpan("s2"));
    store.set("k3", mockSpan("s3"));
    expect(store.size()).toBe(3);

    // Adding a 4th entry should evict k1 (oldest)
    store.set("k4", mockSpan("s4"));
    expect(store.size()).toBe(3);
    expect(store.get("k1")).toBeUndefined();
    expect(store.get("k2")).toBeDefined();
    expect(store.get("k4")).toBeDefined();
  });

  test("re-setting same key moves it to newest position", () => {
    const store = createSpanContextStore(3);

    store.set("k1", mockSpan("s1"));
    store.set("k2", mockSpan("s2"));
    store.set("k3", mockSpan("s3"));

    // Re-set k1 — makes it newest
    const updatedSpan = mockSpan("s1-updated");
    store.set("k1", updatedSpan);
    expect(store.get("k1")).toBe(updatedSpan);

    // Adding k4 should now evict k2 (the oldest), not k1
    store.set("k4", mockSpan("s4"));
    expect(store.get("k1")).toBe(updatedSpan);
    expect(store.get("k2")).toBeUndefined();
    expect(store.get("k3")).toBeDefined();
    expect(store.get("k4")).toBeDefined();
  });
});
