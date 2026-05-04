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
    expect(sessions.sort()).toEqual(["sess-x", "sess-y"]);
  });

  test("colon in session id is sanitized for storage", async () => {
    const store = newStore();
    await store.append("a:b:c", [makeEntry(0, "tool")]);
    const entries = await store.getSession("a:b:c");
    expect(entries.length).toBe(1);
    expect(entries[0]?.identifier).toBe("tool");
  });
});
