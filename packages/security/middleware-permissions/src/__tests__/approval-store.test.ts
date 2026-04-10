import { afterEach, describe, expect, test } from "bun:test";
import type { ApprovalStore } from "../approval-store.js";
import { createApprovalStore } from "../approval-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// let: stores accumulate across tests and are cleaned up in afterEach
let stores: ApprovalStore[] = [];

function makeStore(): ApprovalStore {
  const store = createApprovalStore({ dbPath: ":memory:" });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const s of stores) {
    s.close();
  }
  stores = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createApprovalStore", () => {
  test("grant + has round-trip", () => {
    const store = makeStore();
    store.grant("user-1", "agent:main", "bash", 1000);
    expect(store.has("user-1", "agent:main", "bash")).toBe(true);
  });

  test("has returns false for non-existent grant", () => {
    const store = makeStore();
    expect(store.has("user-1", "agent:main", "bash")).toBe(false);
  });

  test("different userId = different grant", () => {
    const store = makeStore();
    store.grant("user-1", "agent:main", "bash", 1000);
    expect(store.has("user-1", "agent:main", "bash")).toBe(true);
    expect(store.has("user-2", "agent:main", "bash")).toBe(false);
  });

  test("different agentId = different grant", () => {
    const store = makeStore();
    store.grant("user-1", "agent:main", "bash", 1000);
    expect(store.has("user-1", "agent:main", "bash")).toBe(true);
    expect(store.has("user-1", "agent:child", "bash")).toBe(false);
  });

  test("different toolId = different grant", () => {
    const store = makeStore();
    store.grant("user-1", "agent:main", "bash", 1000);
    expect(store.has("user-1", "agent:main", "bash")).toBe(true);
    expect(store.has("user-1", "agent:main", "write")).toBe(false);
  });

  test("duplicate grant is upsert — updates grantedAt", () => {
    const store = makeStore();
    store.grant("user-1", "agent:main", "bash", 1000);
    store.grant("user-1", "agent:main", "bash", 2000);
    const grants = store.list();
    expect(grants).toHaveLength(1);
    expect(grants[0]?.grantedAt).toBe(2000);
  });

  test("revoke returns true when grant exists", () => {
    const store = makeStore();
    store.grant("user-1", "agent:main", "bash", 1000);
    expect(store.revoke("user-1", "agent:main", "bash")).toBe(true);
    expect(store.has("user-1", "agent:main", "bash")).toBe(false);
  });

  test("revoke returns false when grant does not exist", () => {
    const store = makeStore();
    expect(store.revoke("user-1", "agent:main", "bash")).toBe(false);
  });

  test("revokeAll clears everything", () => {
    const store = makeStore();
    store.grant("user-1", "agent:main", "bash", 1000);
    store.grant("user-1", "agent:main", "write", 1001);
    store.grant("user-2", "agent:main", "bash", 1002);
    store.revokeAll();
    expect(store.list()).toHaveLength(0);
    expect(store.has("user-1", "agent:main", "bash")).toBe(false);
  });

  test("list returns all grants ordered by grantedAt descending", () => {
    const store = makeStore();
    store.grant("user-1", "agent:main", "bash", 1000);
    store.grant("user-1", "agent:main", "write", 2000);
    store.grant("user-2", "agent:main", "bash", 1500);
    const grants = store.list();
    expect(grants).toHaveLength(3);
    expect(grants[0]?.grantedAt).toBe(2000);
    expect(grants[1]?.grantedAt).toBe(1500);
    expect(grants[2]?.grantedAt).toBe(1000);
  });

  test("list returns correct field names", () => {
    const store = makeStore();
    store.grant("user-1", "agent:main", "bash", 1000);
    const grant = store.list()[0];
    expect(grant).toEqual({
      userId: "user-1",
      agentId: "agent:main",
      toolId: "bash",
      grantedAt: 1000,
    });
  });

  test("close is idempotent", () => {
    const store = makeStore();
    store.close();
    store.close(); // should not throw
  });
});
