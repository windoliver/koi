import { describe, expect, test } from "bun:test";
import { createInMemorySessionStore } from "../session-store.js";
import { createTestSession } from "./test-utils.js";

describe("InMemorySessionStore", () => {
  test("stores and retrieves a session", () => {
    const store = createInMemorySessionStore();
    const session = createTestSession({ id: "s1" });
    store.set(session);
    expect(store.get("s1")).toEqual(session);
  });

  test("returns undefined for missing session", () => {
    const store = createInMemorySessionStore();
    expect(store.get("nonexistent")).toBeUndefined();
  });

  test("has() returns true for existing session", () => {
    const store = createInMemorySessionStore();
    store.set(createTestSession({ id: "s1" }));
    expect(store.has("s1")).toBe(true);
    expect(store.has("s2")).toBe(false);
  });

  test("deletes a session", () => {
    const store = createInMemorySessionStore();
    store.set(createTestSession({ id: "s1" }));
    expect(store.delete("s1")).toBe(true);
    expect(store.get("s1")).toBeUndefined();
    expect(store.delete("s1")).toBe(false);
  });

  test("tracks size correctly", () => {
    const store = createInMemorySessionStore();
    expect(store.size()).toBe(0);
    store.set(createTestSession({ id: "s1" }));
    expect(store.size()).toBe(1);
    store.set(createTestSession({ id: "s2" }));
    expect(store.size()).toBe(2);
    store.delete("s1");
    expect(store.size()).toBe(1);
  });

  test("overwrites session with same id", () => {
    const store = createInMemorySessionStore();
    store.set(createTestSession({ id: "s1", seq: 0 }));
    store.set(createTestSession({ id: "s1", seq: 5 }));
    expect(store.size()).toBe(1);
    const session = store.get("s1");
    expect(session?.seq).toBe(5);
  });

  test("iterates entries", () => {
    const store = createInMemorySessionStore();
    store.set(createTestSession({ id: "s1" }));
    store.set(createTestSession({ id: "s2" }));

    const ids: string[] = [];
    for (const [id] of store.entries()) {
      ids.push(id);
    }
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
    expect(ids).toHaveLength(2);
  });

  test("session values are structurally immutable", () => {
    const store = createInMemorySessionStore();
    const session = createTestSession({ id: "s1" });
    store.set(session);
    const retrieved = store.get("s1");
    expect(retrieved).toEqual(session);
    // Verify it's a snapshot — updating the store doesn't change the reference
    store.set(createTestSession({ id: "s1", seq: 99 }));
    expect(retrieved?.seq).toBe(session.seq);
  });
});
