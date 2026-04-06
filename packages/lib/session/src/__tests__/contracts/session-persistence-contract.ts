/**
 * Reusable contract test suite for any SessionPersistence implementation.
 *
 * Usage:
 *   runSessionPersistenceContractTests(() => createInMemorySessionPersistence());
 *   runSessionPersistenceContractTests(() => createSqliteSessionPersistence({ dbPath: ":memory:" }));
 *
 * Both implementations run the same suite — prevents silent divergence.
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineState,
  PendingFrame,
  SessionId,
  SessionPersistence,
  SessionRecord,
} from "@koi/core";
import { agentId, sessionId } from "@koi/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testManifest: AgentManifest = {
  name: "test-agent",
  version: "0.1.0",
  description: "Agent for contract testing",
  model: { name: "test-model" },
};

function makeSession(
  overrides: Partial<SessionRecord> & { readonly sessionId: SessionId },
): SessionRecord {
  return {
    agentId: agentId("agent-1"),
    manifestSnapshot: testManifest,
    seq: 0,
    remoteSeq: 0,
    connectedAt: Date.now(),
    lastPersistedAt: Date.now(),
    status: "idle",
    metadata: {},
    ...overrides,
  };
}

function makeFrame(overrides: Partial<PendingFrame> & { readonly frameId: string }): PendingFrame {
  return {
    sessionId: sessionId("session-1"),
    agentId: agentId("agent-1"),
    frameType: "agent:message",
    payload: { text: "hello" },
    orderIndex: 0,
    createdAt: Date.now(),
    retryCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract suite
// ---------------------------------------------------------------------------

export function runSessionPersistenceContractTests(createStore: () => SessionPersistence): void {
  // -----------------------------------------------------------------------
  // Session CRUD
  // -----------------------------------------------------------------------
  describe("session records", () => {
    test("save and load round-trip", async () => {
      const store = createStore();
      const record = makeSession({ sessionId: sessionId("s1") });
      expect((await store.saveSession(record)).ok).toBe(true);

      const result = await store.loadSession("s1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessionId).toBe(sessionId("s1"));
        expect(result.value.agentId).toBe(agentId("agent-1"));
        expect(result.value.manifestSnapshot.name).toBe("test-agent");
      }
    });

    test("save overwrites existing session", async () => {
      const store = createStore();
      await store.saveSession(makeSession({ sessionId: sessionId("s1"), seq: 0 }));
      await store.saveSession(makeSession({ sessionId: sessionId("s1"), seq: 42 }));

      const result = await store.loadSession("s1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.seq).toBe(42);
      }
    });

    test("load returns NOT_FOUND for missing session", async () => {
      const store = createStore();
      const result = await store.loadSession("nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("remove deletes session and associated data", async () => {
      const store = createStore();
      await store.saveSession(
        makeSession({ sessionId: sessionId("s1"), agentId: agentId("agent-rm") }),
      );
      expect((await store.removeSession("s1")).ok).toBe(true);
      expect((await store.loadSession("s1")).ok).toBe(false);
    });

    test("remove returns NOT_FOUND for missing session", async () => {
      const store = createStore();
      const result = await store.removeSession("nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("listSessions returns all sessions", async () => {
      const store = createStore();
      await store.saveSession(makeSession({ sessionId: sessionId("s1"), agentId: agentId("a1") }));
      await store.saveSession(makeSession({ sessionId: sessionId("s2"), agentId: agentId("a2") }));

      const result = await store.listSessions();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });

    test("listSessions filters by agentId", async () => {
      const store = createStore();
      await store.saveSession(makeSession({ sessionId: sessionId("s1"), agentId: agentId("a1") }));
      await store.saveSession(makeSession({ sessionId: sessionId("s2"), agentId: agentId("a2") }));

      const result = await store.listSessions({ agentId: agentId("a1") });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.sessionId).toBe(sessionId("s1"));
      }
    });

    test("empty listSessions returns empty array", async () => {
      const store = createStore();
      const result = await store.listSessions();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });

    test("saveSession preserves lastEngineState", async () => {
      const store = createStore();
      const engineState: EngineState = { engineId: "test-engine", data: { step: 42 } };
      await store.saveSession(
        makeSession({ sessionId: sessionId("s-state"), lastEngineState: engineState }),
      );

      const result = await store.loadSession("s-state");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.lastEngineState?.engineId).toBe("test-engine");
        expect(result.value.lastEngineState?.data).toEqual({ step: 42 });
      }
    });

    test("saveSession without lastEngineState round-trips as undefined", async () => {
      const store = createStore();
      await store.saveSession(makeSession({ sessionId: sessionId("s-no-state") }));
      const result = await store.loadSession("s-no-state");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.lastEngineState).toBeUndefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Recovery
  // -----------------------------------------------------------------------
  describe("recovery", () => {
    test("recover returns empty plan for empty store", async () => {
      const store = createStore();
      const result = await store.recover();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(0);
        expect(result.value.skipped).toEqual([]);
      }
    });

    test("recover returns all sessions", async () => {
      const store = createStore();
      await store.saveSession(
        makeSession({ sessionId: sessionId("s1"), agentId: agentId("agent-1") }),
      );
      await store.saveSession(
        makeSession({ sessionId: sessionId("s2"), agentId: agentId("agent-2") }),
      );

      const result = await store.recover();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(2);
        expect(result.value.skipped).toEqual([]);
      }
    });

    test("recover returns sessions with lastEngineState", async () => {
      const store = createStore();
      const engineState: EngineState = { engineId: "pi", data: { messages: ["hello"] } };
      await store.saveSession(
        makeSession({
          sessionId: sessionId("s-recover"),
          agentId: agentId("agent-state"),
          lastEngineState: engineState,
        }),
      );

      const result = await store.recover();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions[0]?.lastEngineState?.engineId).toBe("pi");
      }
    });

    test("recovery plan has sessions, pendingFrames, skipped — no checkpoints", async () => {
      const store = createStore();
      await store.saveSession(makeSession({ sessionId: sessionId("s1"), agentId: agentId("a1") }));

      const result = await store.recover();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveProperty("sessions");
        expect(result.value).toHaveProperty("pendingFrames");
        expect(result.value).toHaveProperty("skipped");
        expect(result.value).not.toHaveProperty("checkpoints");
      }
    });

    test("recover with 10 agents", async () => {
      const store = createStore();
      for (let i = 0; i < 10; i++) {
        await store.saveSession(
          makeSession({ sessionId: sessionId(`s-${i}`), agentId: agentId(`agent-${i}`) }),
        );
      }

      const result = await store.recover();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(10);
        expect(result.value.skipped).toEqual([]);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Pending frames
  // -----------------------------------------------------------------------
  describe("pending frames", () => {
    test("savePendingFrame persists frame", async () => {
      const store = createStore();
      await store.saveSession(makeSession({ sessionId: sessionId("s1") }));
      await store.savePendingFrame(makeFrame({ frameId: "f1", sessionId: sessionId("s1") }));

      const result = await store.loadPendingFrames("s1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.frameId).toBe("f1");
      }
    });

    test("loadPendingFrames ordered by orderIndex", async () => {
      const store = createStore();
      await store.saveSession(makeSession({ sessionId: sessionId("s1") }));
      await store.savePendingFrame(
        makeFrame({ frameId: "f3", sessionId: sessionId("s1"), orderIndex: 3 }),
      );
      await store.savePendingFrame(
        makeFrame({ frameId: "f1", sessionId: sessionId("s1"), orderIndex: 1 }),
      );
      await store.savePendingFrame(
        makeFrame({ frameId: "f2", sessionId: sessionId("s1"), orderIndex: 2 }),
      );

      const result = await store.loadPendingFrames("s1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((f) => f.frameId)).toEqual(["f1", "f2", "f3"]);
      }
    });

    test("loadPendingFrames returns empty for unknown session", async () => {
      const store = createStore();
      const result = await store.loadPendingFrames("unknown");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });

    test("clearPendingFrames removes all for session", async () => {
      const store = createStore();
      await store.saveSession(makeSession({ sessionId: sessionId("s1") }));
      await store.savePendingFrame(
        makeFrame({ frameId: "f1", sessionId: sessionId("s1"), orderIndex: 0 }),
      );
      await store.savePendingFrame(
        makeFrame({ frameId: "f2", sessionId: sessionId("s1"), orderIndex: 1 }),
      );
      await store.clearPendingFrames("s1");

      const result = await store.loadPendingFrames("s1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });

    test("clearPendingFrames does not affect other sessions", async () => {
      const store = createStore();
      await store.saveSession(makeSession({ sessionId: sessionId("s1") }));
      await store.saveSession(makeSession({ sessionId: sessionId("s2") }));
      await store.savePendingFrame(
        makeFrame({ frameId: "f1", sessionId: sessionId("s1"), orderIndex: 0 }),
      );
      await store.savePendingFrame(
        makeFrame({ frameId: "f2", sessionId: sessionId("s2"), orderIndex: 0 }),
      );
      await store.clearPendingFrames("s1");

      const result = await store.loadPendingFrames("s2");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.frameId).toBe("f2");
      }
    });

    test("removeSession cascades to pending frames", async () => {
      const store = createStore();
      const aid = agentId("agent-pf");
      await store.saveSession(makeSession({ sessionId: sessionId("s1"), agentId: aid }));
      await store.savePendingFrame(
        makeFrame({ frameId: "f1", sessionId: sessionId("s1"), agentId: aid, orderIndex: 0 }),
      );
      await store.removeSession("s1");

      const result = await store.loadPendingFrames("s1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });

    test("removeSession only clears its own pending frames", async () => {
      const store = createStore();
      const aid = agentId("agent-cascade");
      await store.saveSession(makeSession({ sessionId: sessionId("s1"), agentId: aid }));
      await store.saveSession(makeSession({ sessionId: sessionId("s2"), agentId: aid }));
      await store.savePendingFrame(
        makeFrame({ frameId: "f1", sessionId: sessionId("s1"), agentId: aid, orderIndex: 0 }),
      );
      await store.savePendingFrame(
        makeFrame({ frameId: "f2", sessionId: sessionId("s2"), agentId: aid, orderIndex: 0 }),
      );
      await store.removeSession("s1");

      const result = await store.loadPendingFrames("s2");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.frameId).toBe("f2");
      }
    });

    test("recover includes pending frames", async () => {
      const store = createStore();
      const aid = agentId("agent-recover-pf");
      await store.saveSession(makeSession({ sessionId: sessionId("s1"), agentId: aid }));
      await store.savePendingFrame(
        makeFrame({ frameId: "f1", sessionId: sessionId("s1"), agentId: aid, orderIndex: 0 }),
      );
      await store.savePendingFrame(
        makeFrame({ frameId: "f2", sessionId: sessionId("s1"), agentId: aid, orderIndex: 1 }),
      );

      const result = await store.recover();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pendingFrames.size).toBe(1);
        const frames = result.value.pendingFrames.get("s1");
        expect(frames?.length).toBe(2);
        expect(result.value.skipped).toEqual([]);
      }
    });

    test("removePendingFrame removes single frame", async () => {
      const store = createStore();
      await store.saveSession(makeSession({ sessionId: sessionId("s1") }));
      await store.savePendingFrame(
        makeFrame({ frameId: "f1", sessionId: sessionId("s1"), orderIndex: 0 }),
      );
      await store.savePendingFrame(
        makeFrame({ frameId: "f2", sessionId: sessionId("s1"), orderIndex: 1 }),
      );
      await store.removePendingFrame("f1");

      const result = await store.loadPendingFrames("s1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.frameId).toBe("f2");
      }
    });

    test("removePendingFrame for unknown frameId is no-op", async () => {
      const store = createStore();
      await store.saveSession(makeSession({ sessionId: sessionId("s1") }));
      await store.savePendingFrame(
        makeFrame({ frameId: "f1", sessionId: sessionId("s1"), orderIndex: 0 }),
      );
      expect((await store.removePendingFrame("nonexistent")).ok).toBe(true);

      const result = await store.loadPendingFrames("s1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
      }
    });

    test("savePendingFrame upserts retryCount", async () => {
      const store = createStore();
      await store.saveSession(makeSession({ sessionId: sessionId("s1") }));
      await store.savePendingFrame(
        makeFrame({ frameId: "f1", sessionId: sessionId("s1"), orderIndex: 0, retryCount: 0 }),
      );
      await store.savePendingFrame(
        makeFrame({ frameId: "f1", sessionId: sessionId("s1"), orderIndex: 0, retryCount: 3 }),
      );

      const result = await store.loadPendingFrames("s1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.retryCount).toBe(3);
      }
    });

    test("pending frame preserves payload round-trip", async () => {
      const store = createStore();
      await store.saveSession(makeSession({ sessionId: sessionId("s1") }));
      const payload = { nested: { data: [1, 2, 3] }, flag: true };
      await store.savePendingFrame(
        makeFrame({ frameId: "f1", sessionId: sessionId("s1"), payload, orderIndex: 0 }),
      );

      const result = await store.loadPendingFrames("s1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value[0]?.payload).toEqual(payload);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------
  describe("validation", () => {
    test("saveSession rejects empty session ID", async () => {
      const store = createStore();
      const result = await store.saveSession(makeSession({ sessionId: sessionId("") }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("saveSession rejects empty agent ID", async () => {
      const store = createStore();
      const result = await store.saveSession(
        makeSession({ sessionId: sessionId("s1"), agentId: agentId("") }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("loadSession rejects empty session ID", async () => {
      const store = createStore();
      const result = await store.loadSession("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("removeSession with empty ID returns VALIDATION", async () => {
      const store = createStore();
      const result = await store.removeSession("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe("edge cases", () => {
    test("engine state with null data round-trips", async () => {
      const store = createStore();
      const nullState: EngineState = { engineId: "test", data: null };
      await store.saveSession(
        makeSession({ sessionId: sessionId("s-null-state"), lastEngineState: nullState }),
      );

      const result = await store.loadSession("s-null-state");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.lastEngineState?.data).toBeNull();
      }
    });

    test("engine state with large data (>1MB) round-trips", async () => {
      const store = createStore();
      const largeData = {
        messages: Array.from({ length: 10000 }, (_, i) => ({
          role: "assistant",
          content: `Message ${i}: ${"x".repeat(100)}`,
        })),
      };
      await store.saveSession(
        makeSession({
          sessionId: sessionId("s-large-state"),
          lastEngineState: { engineId: "test", data: largeData },
        }),
      );

      const result = await store.loadSession("s-large-state");
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.value.lastEngineState?.data as typeof largeData;
        expect(data.messages.length).toBe(10000);
      }
    });

    test("unicode in metadata round-trips", async () => {
      const store = createStore();
      await store.saveSession(
        makeSession({
          sessionId: sessionId("s-unicode"),
          agentId: agentId("agent-unicode"),
          metadata: { name: "工具-名前-도구", emoji: "🤖" },
        }),
      );

      const result = await store.loadSession("s-unicode");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metadata).toEqual({ name: "工具-名前-도구", emoji: "🤖" });
      }
    });

    test("overwrite session then recover returns latest seq", async () => {
      const store = createStore();
      const aid = agentId("agent-overwrite");
      await store.saveSession(makeSession({ sessionId: sessionId("s1"), agentId: aid, seq: 1 }));
      await store.saveSession(makeSession({ sessionId: sessionId("s1"), agentId: aid, seq: 99 }));

      const result = await store.recover();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(1);
        expect(result.value.sessions[0]?.seq).toBe(99);
      }
    });
  });
}
