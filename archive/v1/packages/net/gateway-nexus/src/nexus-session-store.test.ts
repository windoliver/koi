import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { Session } from "@koi/gateway-types";
import type { NexusClient } from "@koi/nexus-client";
import { runSessionStoreContractTests } from "@koi/test-utils";
import type { NexusSessionStoreHandle } from "./nexus-session-store.js";
import { createNexusSessionStore } from "./nexus-session-store.js";

// ---------------------------------------------------------------------------
// Test NexusClient factory — concentrates the generic interface mock in one place.
// TypeScript cannot structurally satisfy a generic method from a concrete mock,
// so a single assertion here is unavoidable for test mocking.
// ---------------------------------------------------------------------------

function createTestNexusClient(
  handler: (method: string, params: Record<string, unknown>) => Promise<Result<unknown, KoiError>>,
): NexusClient {
  return { rpc: handler } as NexusClient;
}

// Run shared contract suite against Nexus-backed implementation
runSessionStoreContractTests(() => {
  const client = createTestNexusClient(async (method) => {
    if (method === "read") {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: "not found", retryable: false },
      };
    }
    return { ok: true, value: null };
  });
  const handle = createNexusSessionStore({
    client,
    config: {
      nexusUrl: "http://localhost:2026",
      apiKey: "test-key",
      writeQueue: { flushIntervalMs: 60_000 },
    },
  });
  return handle.store;
});

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

function createMockClient(): {
  readonly client: NexusClient;
  readonly calls: Array<{ readonly method: string; readonly params: Record<string, unknown> }>;
  readonly setResponse: (r: Result<unknown, KoiError>) => void;
} {
  const calls: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = [];
  let nextResponse: Result<unknown, KoiError> = { ok: true, value: null };

  return {
    client: createTestNexusClient(async (method, params) => {
      calls.push({ method, params });
      return nextResponse;
    }),
    calls,
    setResponse: (r: Result<unknown, KoiError>) => {
      nextResponse = r;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NexusSessionStore", () => {
  let mock: ReturnType<typeof createMockClient>;
  let handle: NexusSessionStoreHandle;

  beforeEach(() => {
    mock = createMockClient();
    handle = createNexusSessionStore({
      client: mock.client,
      config: {
        nexusUrl: "http://localhost:2026",
        apiKey: "test-key",
        instanceId: "instance-1",
        writeQueue: { flushIntervalMs: 60_000 },
      },
    });
  });

  afterEach(async () => {
    await handle.dispose();
  });

  test("set stores session and returns from cache on get", async () => {
    const session = makeSession();
    const setResult = await handle.store.set(session);
    expect(setResult.ok).toBe(true);

    const getResult = handle.store.get("sess-1");
    expect(getResult).toEqual({ ok: true, value: session });
  });

  test("get returns NOT_FOUND for unknown session", async () => {
    mock.setResponse({
      ok: false,
      error: { code: "NOT_FOUND", message: "not found", retryable: false },
    });
    const r = await handle.store.get("missing");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  test("has returns true after set, false after delete", () => {
    const session = makeSession();
    handle.store.set(session);
    expect(handle.store.has("sess-1")).toEqual({ ok: true, value: true });

    handle.store.delete("sess-1");
    expect(handle.store.has("sess-1")).toEqual({ ok: true, value: false });
  });

  test("delete returns false for non-existent session", () => {
    const r = handle.store.delete("missing");
    expect(r).toEqual({ ok: true, value: false });
  });

  test("size tracks entries", () => {
    expect(handle.store.size()).toBe(0);
    handle.store.set(makeSession({ id: "a" }));
    handle.store.set(makeSession({ id: "b" }));
    expect(handle.store.size()).toBe(2);
  });

  test("entries iterates all cached sessions", () => {
    handle.store.set(makeSession({ id: "a" }));
    handle.store.set(makeSession({ id: "b" }));
    const entries = [...handle.store.entries()];
    expect(entries).toHaveLength(2);
    const ids = entries.map(([id]) => id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });

  test("set enqueues immediate write for new sessions", async () => {
    handle.store.set(makeSession());
    // Immediate writes go to writeFn directly
    await new Promise((r) => setTimeout(r, 20));
    const writeCalls = mock.calls.filter((c) => c.method === "write");
    expect(writeCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("update enqueues coalesced write for existing sessions", async () => {
    handle.store.set(makeSession());
    await new Promise((r) => setTimeout(r, 20));
    const initialCalls = mock.calls.length;

    // Update existing session — should coalesce, not write immediately
    handle.store.set(makeSession({ lastHeartbeat: Date.now() + 1000 }));
    // No immediate write — check that no new rpc call happened synchronously
    expect(mock.calls.length).toBe(initialCalls);
  });

  test("get fetches from Nexus on cache miss", async () => {
    const session = makeSession({ id: "remote-sess" });
    mock.setResponse({
      ok: true,
      value: JSON.stringify({
        session,
        ownerInstance: "other-instance",
        ownedSince: Date.now(),
        version: 1,
      }),
    });

    const r = await handle.store.get("remote-sess");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe("remote-sess");
    }
    // Subsequent get should come from cache
    const r2 = handle.store.get("remote-sess");
    expect(r2).toEqual({ ok: true, value: session });
  });

  test("starts in healthy mode", () => {
    expect(handle.degradation().mode).toBe("healthy");
  });

  test("transitions to degraded after failures", async () => {
    mock.setResponse({
      ok: false,
      error: { code: "EXTERNAL", message: "server error", retryable: true },
    });
    // Trigger multiple cache misses to accumulate failures
    for (let i = 0; i < 4; i++) {
      await handle.store.get(`missing-${i}`);
    }
    expect(handle.degradation().mode).toBe("degraded");
  });
});
