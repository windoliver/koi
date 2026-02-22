import { describe, expect, test } from "bun:test";
import { createInMemorySessionStore } from "../session-store.js";
import { createTestSession } from "./test-utils.js";

describe("InMemorySessionStore", () => {
  test("stores and retrieves a session", async () => {
    const store = createInMemorySessionStore();
    const session = createTestSession({ id: "s1" });
    await store.set(session);
    const result = await store.get("s1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(session);
    }
  });

  test("returns not-found error for missing session", async () => {
    const store = createInMemorySessionStore();
    const result = await store.get("nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("has() returns true for existing session", async () => {
    const store = createInMemorySessionStore();
    await store.set(createTestSession({ id: "s1" }));
    const hasResult = await store.has("s1");
    expect(hasResult.ok).toBe(true);
    if (hasResult.ok) expect(hasResult.value).toBe(true);
    const notHasResult = await store.has("s2");
    expect(notHasResult.ok).toBe(true);
    if (notHasResult.ok) expect(notHasResult.value).toBe(false);
  });

  test("deletes a session", async () => {
    const store = createInMemorySessionStore();
    await store.set(createTestSession({ id: "s1" }));
    const delResult = await store.delete("s1");
    expect(delResult.ok).toBe(true);
    if (delResult.ok) expect(delResult.value).toBe(true);
    const getResult = await store.get("s1");
    expect(getResult.ok).toBe(false);
    const delAgain = await store.delete("s1");
    expect(delAgain.ok).toBe(true);
    if (delAgain.ok) expect(delAgain.value).toBe(false);
  });

  test("tracks size correctly", async () => {
    const store = createInMemorySessionStore();
    expect(store.size()).toBe(0);
    await store.set(createTestSession({ id: "s1" }));
    expect(store.size()).toBe(1);
    await store.set(createTestSession({ id: "s2" }));
    expect(store.size()).toBe(2);
    await store.delete("s1");
    expect(store.size()).toBe(1);
  });

  test("overwrites session with same id", async () => {
    const store = createInMemorySessionStore();
    await store.set(createTestSession({ id: "s1", seq: 0 }));
    await store.set(createTestSession({ id: "s1", seq: 5 }));
    expect(store.size()).toBe(1);
    const result = await store.get("s1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.seq).toBe(5);
  });

  test("iterates entries", async () => {
    const store = createInMemorySessionStore();
    await store.set(createTestSession({ id: "s1" }));
    await store.set(createTestSession({ id: "s2" }));

    const ids: string[] = [];
    for (const [id] of store.entries()) {
      ids.push(id);
    }
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
    expect(ids).toHaveLength(2);
  });

  test("session values are structurally immutable", async () => {
    const store = createInMemorySessionStore();
    const session = createTestSession({ id: "s1" });
    await store.set(session);
    const result = await store.get("s1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const retrieved = result.value;
    // Verify it's a snapshot — updating the store doesn't change the reference
    await store.set(createTestSession({ id: "s1", seq: 99 }));
    expect(retrieved.seq).toBe(session.seq);
  });

  test("set returns ok result", async () => {
    const store = createInMemorySessionStore();
    const result = await store.set(createTestSession({ id: "s1" }));
    expect(result.ok).toBe(true);
  });
});
