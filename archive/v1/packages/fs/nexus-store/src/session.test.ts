/**
 * Tests for the Nexus-backed SessionPersistence in @koi/nexus-store.
 *
 * Uses the contract test suite from @koi/test-utils, plus Nexus-specific
 * tests for recovery and error handling.
 */

import { describe, expect, test } from "bun:test";
import type { AgentId, PendingFrame, SessionRecord } from "@koi/core";
import { agentId, sessionId } from "@koi/core";
import { createFakeNexusFetch, runSessionPersistenceContractTests } from "@koi/test-utils";
import { createNexusSessionStore } from "./session.js";

// ---------------------------------------------------------------------------
// Contract test suite
// ---------------------------------------------------------------------------

runSessionPersistenceContractTests(() =>
  createNexusSessionStore({
    baseUrl: "http://fake-nexus",
    apiKey: "test-key",
    fetch: createFakeNexusFetch(),
  }),
);

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

const TEST_MANIFEST = {
  name: "test-agent",
  version: "0.1.0",
  description: "test",
  model: { name: "test-model" },
} as const;

function makeSession(sid: string, aid: AgentId): SessionRecord {
  return {
    sessionId: sessionId(sid),
    agentId: aid,
    manifestSnapshot: TEST_MANIFEST,
    seq: 0,
    remoteSeq: 0,
    connectedAt: Date.now(),
    lastPersistedAt: Date.now(),
    metadata: {},
  };
}

function makeFrame(frameId: string, sid: string, orderIndex: number): PendingFrame {
  return {
    frameId,
    sessionId: sessionId(sid),
    agentId: agentId("test-agent"),
    frameType: "tool_call",
    payload: {},
    orderIndex,
    createdAt: Date.now(),
    retryCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Nexus-specific tests
// ---------------------------------------------------------------------------

describe("createNexusSessionStore — nexus-specific", () => {
  function createStore(): ReturnType<typeof createNexusSessionStore> {
    return createNexusSessionStore({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: createFakeNexusFetch(),
    });
  }

  test("removeSession cascades to pending frames", async () => {
    const store = createStore();
    const aid = agentId("agent-cascade");
    const sid = "sess-cascade";

    await store.saveSession(makeSession(sid, aid));
    await store.savePendingFrame(makeFrame("frame-1", sid, 0));

    const removeResult = await store.removeSession(sid);
    expect(removeResult.ok).toBe(true);

    // Session should be gone
    const loadResult = await store.loadSession(sid);
    expect(loadResult.ok).toBe(false);

    // Pending frames should be gone
    const framesResult = await store.loadPendingFrames(sid);
    expect(framesResult.ok).toBe(true);
    if (framesResult.ok) {
      expect(framesResult.value).toHaveLength(0);
    }

    store.close();
  });

  test("listSessions filters by agentId", async () => {
    const store = createStore();
    const aid1 = agentId("agent-1");
    const aid2 = agentId("agent-2");

    await store.saveSession(makeSession("s1", aid1));
    await store.saveSession(makeSession("s2", aid2));
    await store.saveSession(makeSession("s3", aid1));

    const result = await store.listSessions({ agentId: aid1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      for (const s of result.value) {
        expect(s.agentId).toBe(aid1);
      }
    }

    store.close();
  });

  test("pending frames sort by orderIndex", async () => {
    const store = createStore();
    const sid = "sess-frames";
    const aid = agentId("agent-frames");

    await store.saveSession(makeSession(sid, aid));

    // Save frames out of order
    await store.savePendingFrame(makeFrame("f3", sid, 3));
    await store.savePendingFrame(makeFrame("f1", sid, 1));
    await store.savePendingFrame(makeFrame("f2", sid, 2));

    const result = await store.loadPendingFrames(sid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
      expect(result.value[0]?.frameId).toBe("f1");
      expect(result.value[1]?.frameId).toBe("f2");
      expect(result.value[2]?.frameId).toBe("f3");
    }

    store.close();
  });

  test("recover collects sessions and pending frames", async () => {
    const store = createStore();
    const aid = agentId("agent-recovery");
    const sid = "sess-recovery";

    await store.saveSession(makeSession(sid, aid));
    await store.savePendingFrame(makeFrame("frame-r", sid, 0));

    const result = await store.recover();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sessions.length).toBeGreaterThanOrEqual(1);
      expect(result.value.pendingFrames.size).toBeGreaterThanOrEqual(1);
    }

    store.close();
  });

  test("handles Nexus errors gracefully", async () => {
    const failFetch = (async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      throw new Error("Network failure");
    }) as typeof globalThis.fetch;

    const store = createNexusSessionStore({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: failFetch,
    });

    const result = await store.saveSession(makeSession("s-fail", agentId("a-fail")));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
    }

    store.close();
  });
});
