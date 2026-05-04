import { describe, expect, test } from "bun:test";

import type { TrajectoryEntry } from "@koi/ace-types";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";

import { createNexusTrajectoryStore } from "../trajectory.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(turnIndex: number, identifier: string): TrajectoryEntry {
  return {
    turnIndex,
    timestamp: turnIndex * 1000,
    kind: "tool_call",
    identifier,
    outcome: "success",
    durationMs: 12,
  };
}

function newStore() {
  return createNexusTrajectoryStore({ transport: createFakeNexusTransport() });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNexusTrajectoryStore", () => {
  test("append + getSession round-trip", async () => {
    const store = newStore();
    await store.append("sess-1", [makeEntry(0, "read_file"), makeEntry(1, "write_file")]);
    const entries = await store.getSession("sess-1");
    expect(entries.length).toBe(2);
    expect(entries[0]?.identifier).toBe("read_file");
    expect(entries[1]?.identifier).toBe("write_file");
  });

  test("append accumulates across calls", async () => {
    const store = newStore();
    await store.append("sess-2", [makeEntry(0, "a")]);
    await store.append("sess-2", [makeEntry(1, "b"), makeEntry(2, "c")]);
    const entries = await store.getSession("sess-2");
    expect(entries.length).toBe(3);
    expect(entries.map((e) => e.identifier)).toEqual(["a", "b", "c"]);
  });

  test("getSession of unknown returns []", async () => {
    const store = newStore();
    const entries = await store.getSession("unknown-session");
    expect(entries).toEqual([]);
  });

  test("listSessions returns saved session ids", async () => {
    const store = newStore();
    await store.append("sess-x", [makeEntry(0, "tool")]);
    await store.append("sess-y", [makeEntry(0, "tool")]);
    const sessions = await store.listSessions();
    expect([...sessions].sort()).toEqual(["sess-x", "sess-y"]);
  });

  test("colon in session id is sanitized for storage", async () => {
    const store = newStore();
    await store.append("a:b:c", [makeEntry(0, "tool")]);
    const entries = await store.getSession("a:b:c");
    expect(entries.length).toBe(1);
    expect(entries[0]?.identifier).toBe("tool");
  });

  // --- contract parity tests (ported from sqlite sibling) ---

  test("append preserves insertion order within a single call", async () => {
    // Entries within a single append call must be returned in the order they
    // were passed, not sorted or reordered. Matches sqlite row-insert order.
    const store = newStore();
    await store.append("sess-order", [
      makeEntry(0, "first"),
      makeEntry(1, "second"),
      makeEntry(2, "third"),
    ]);
    const entries = await store.getSession("sess-order");
    expect(entries.map((e) => e.identifier)).toEqual(["first", "second", "third"]);
  });

  test("append preserves insertion order across multiple calls", async () => {
    // Across appends, earlier-appended entries must come before later-appended ones.
    const store = newStore();
    await store.append("sess-multi", [makeEntry(0, "a"), makeEntry(1, "b")]);
    await store.append("sess-multi", [makeEntry(2, "c")]);
    const entries = await store.getSession("sess-multi");
    expect(entries.map((e) => e.identifier)).toEqual(["a", "b", "c"]);
  });

  test("listSessions before option is not supported (nexus ignores it)", async () => {
    // DIVERGENCE vs sqlite: sqlite respects the `before` timestamp cursor to
    // exclude sessions whose last activity timestamp >= `before`. Nexus has no
    // per-session activity timestamp index and ignores the `before` option,
    // returning all sessions regardless. Documented in
    // docs/L2/playbook-store-nexus.md.
    const store = newStore();
    await store.append("sess-a", [makeEntry(0, "tool")]);
    await store.append("sess-b", [makeEntry(0, "tool")]);
    // sqlite: before=0 would return [] (all sessions have timestamp >= 0)
    // nexus: before is ignored, returns all sessions
    const sessions = await store.listSessions({ before: 0 });
    // nexus returns both regardless of before
    expect([...sessions].sort()).toEqual(["sess-a", "sess-b"]);
  });

  // --- ACE ID path-safety regression tests (Finding 1) ---

  test("append with session id containing '/' is rejected", async () => {
    const store = newStore();
    await expect(store.append("a/b", [makeEntry(0, "tool")])).rejects.toThrow("Session ID");
  });

  test("append with session id containing '..' is rejected", async () => {
    const store = newStore();
    await expect(store.append("a..b", [makeEntry(0, "tool")])).rejects.toThrow("Session ID");
  });

  test("append with session id containing backslash is rejected", async () => {
    const store = newStore();
    await expect(store.append("a\\b", [makeEntry(0, "tool")])).rejects.toThrow("Session ID");
  });

  test("append with session id containing null byte is rejected", async () => {
    const store = newStore();
    await expect(store.append("a\0b", [makeEntry(0, "tool")])).rejects.toThrow("Session ID");
  });

  test("'a:b' and 'a_b' are distinct sessions — no collision", async () => {
    const store = newStore();
    await store.append("a:b", [makeEntry(0, "colon")]);
    await store.append("a_b", [makeEntry(0, "underscore")]);
    expect((await store.getSession("a:b"))[0]?.identifier).toBe("colon");
    expect((await store.getSession("a_b"))[0]?.identifier).toBe("underscore");
  });

  test("listSessions returns original session IDs with colons (not encoded)", async () => {
    const store = newStore();
    await store.append("session:2026:abc", [makeEntry(0, "tool")]);
    const sessions = await store.listSessions();
    expect(sessions).toContain("session:2026:abc");
  });

  // --- Concurrent append regression test (Finding 5) ---

  test("concurrent append calls serialize — all entries present", async () => {
    const store = newStore();
    // Fire two concurrent appends to the same session
    await Promise.all([
      store.append("concurrent-sess", [makeEntry(0, "first"), makeEntry(1, "second")]),
      store.append("concurrent-sess", [makeEntry(2, "third"), makeEntry(3, "fourth")]),
    ]);
    const entries = await store.getSession("concurrent-sess");
    expect(entries.length).toBe(4);
    const ids = entries.map((e) => e.identifier).sort();
    expect(ids).toEqual(["first", "fourth", "second", "third"]);
  });
});
