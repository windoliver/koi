import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { createInMemorySessionStore } from "../session-store.js";
import type { Session } from "../types.js";

// In-memory store is always sync — cast to sync Result for test assertions
function syncGet(
  store: ReturnType<typeof createInMemorySessionStore>,
  id: string,
): Result<Session, KoiError> {
  return store.get(id) as Result<Session, KoiError>;
}

function makeSession(id: string): Session {
  return {
    id,
    agentId: "agent-1",
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    seq: 0,
    remoteSeq: 0,
    metadata: {},
  };
}

describe("createInMemorySessionStore", () => {
  test("get returns NOT_FOUND for missing session", () => {
    const store = createInMemorySessionStore();
    const r = syncGet(store, "missing");
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  test("set and get round-trip", () => {
    const store = createInMemorySessionStore();
    const s = makeSession("s1");
    store.set(s);
    const r = syncGet(store, "s1");
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.value.id).toBe("s1");
  });

  test("has returns true after set", () => {
    const store = createInMemorySessionStore();
    store.set(makeSession("s2"));
    expect(store.has("s2")).toMatchObject({ ok: true, value: true });
  });

  test("has returns false for missing", () => {
    const store = createInMemorySessionStore();
    expect(store.has("nope")).toMatchObject({ ok: true, value: false });
  });

  test("delete removes session", () => {
    const store = createInMemorySessionStore();
    store.set(makeSession("s3"));
    const r = store.delete("s3");
    expect(r).toMatchObject({ ok: true, value: true });
    expect(store.has("s3")).toMatchObject({ ok: true, value: false });
  });

  test("delete returns false for missing", () => {
    const store = createInMemorySessionStore();
    expect(store.delete("none")).toMatchObject({ ok: true, value: false });
  });

  test("size returns count", () => {
    const store = createInMemorySessionStore();
    expect(store.size()).toBe(0);
    store.set(makeSession("a"));
    store.set(makeSession("b"));
    expect(store.size()).toBe(2);
  });

  test("set overwrites existing session", () => {
    const store = createInMemorySessionStore();
    store.set(makeSession("s4"));
    const updated = { ...makeSession("s4"), agentId: "agent-updated" };
    store.set(updated);
    const r = syncGet(store, "s4");
    if (r.ok) expect(r.value.agentId).toBe("agent-updated");
  });

  test("entries iterates all sessions", () => {
    const store = createInMemorySessionStore();
    store.set(makeSession("e1"));
    store.set(makeSession("e2"));
    const ids = [...store.entries()].map(([id]) => id);
    expect(ids.sort()).toEqual(["e1", "e2"]);
  });
});
