/**
 * Reusable contract test suite for any SessionStore implementation.
 *
 * Call `runSessionStoreContractTests(factory)` with a factory that
 * creates a fresh store per test group.
 */

import { describe, expect, test } from "bun:test";
import type { Session, SessionStore } from "@koi/gateway-types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: "sess-1",
    agentId: "agent-1",
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    seq: 0,
    remoteSeq: 0,
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract suite
// ---------------------------------------------------------------------------

export function runSessionStoreContractTests(
  createStore: () => SessionStore | Promise<SessionStore>,
): void {
  describe("SessionStore contract", () => {
    describe("CRUD", () => {
      test("set and get returns session", async () => {
        const store = await createStore();
        const session = makeSession();
        await store.set(session);
        const r = await store.get("sess-1");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.id).toBe("sess-1");
      });

      test("get returns NOT_FOUND for missing session", async () => {
        const store = await createStore();
        const r = await store.get("missing");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
      });

      test("set overwrites existing session", async () => {
        const store = await createStore();
        await store.set(makeSession({ seq: 1 }));
        await store.set(makeSession({ seq: 42 }));
        const r = await store.get("sess-1");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.seq).toBe(42);
      });

      test("delete removes session and returns true", async () => {
        const store = await createStore();
        await store.set(makeSession());
        const r = await store.delete("sess-1");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toBe(true);

        const get = await store.get("sess-1");
        expect(get.ok).toBe(false);
      });

      test("delete returns false for non-existent session", async () => {
        const store = await createStore();
        const r = await store.delete("missing");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toBe(false);
      });
    });

    describe("has / size / entries", () => {
      test("has returns true after set, false after delete", async () => {
        const store = await createStore();
        await store.set(makeSession());
        const has1 = await store.has("sess-1");
        expect(has1).toEqual({ ok: true, value: true });

        await store.delete("sess-1");
        const has2 = await store.has("sess-1");
        expect(has2).toEqual({ ok: true, value: false });
      });

      test("size tracks number of sessions", async () => {
        const store = await createStore();
        expect(store.size()).toBe(0);
        await store.set(makeSession({ id: "a" }));
        await store.set(makeSession({ id: "b" }));
        expect(store.size()).toBe(2);
      });

      test("entries iterates all sessions", async () => {
        const store = await createStore();
        await store.set(makeSession({ id: "a" }));
        await store.set(makeSession({ id: "b" }));
        const entries = [...store.entries()];
        expect(entries).toHaveLength(2);
        const ids = entries.map(([id]) => id);
        expect(ids).toContain("a");
        expect(ids).toContain("b");
      });
    });
  });
}
