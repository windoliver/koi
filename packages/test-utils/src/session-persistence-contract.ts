/**
 * Reusable contract test suite for any SessionPersistence implementation.
 *
 * Call `runSessionPersistenceContractTests(factory)` with a factory that
 * creates a fresh store per test group.
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentId,
  AgentManifest,
  EngineState,
  PendingFrame,
  SessionCheckpoint,
  SessionPersistence,
  SessionRecord,
} from "@koi/core";
import { agentId } from "@koi/core";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const testManifest: AgentManifest = {
  name: "test-agent",
  version: "0.1.0",
  description: "Agent for contract testing",
  model: { name: "test-model" },
};

function makeSessionRecord(
  overrides: Partial<SessionRecord> & { readonly sessionId: string },
): SessionRecord {
  return {
    agentId: agentId("agent-1"),
    manifestSnapshot: testManifest,
    seq: 0,
    remoteSeq: 0,
    connectedAt: Date.now(),
    lastCheckpointAt: Date.now(),
    metadata: {},
    ...overrides,
  };
}

function makePendingFrame(
  overrides: Partial<PendingFrame> & { readonly frameId: string },
): PendingFrame {
  return {
    sessionId: "session-1",
    agentId: agentId("agent-1"),
    frameType: "agent:message",
    payload: { text: "hello" },
    orderIndex: 0,
    createdAt: Date.now(),
    retryCount: 0,
    ...overrides,
  };
}

function makeCheckpoint(
  overrides: Partial<SessionCheckpoint> & { readonly id: string; readonly agentId: AgentId },
): SessionCheckpoint {
  return {
    sessionId: "session-1",
    engineState: { engineId: "test-engine", data: { turnCount: 1 } },
    processState: "running",
    generation: 1,
    metadata: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

export function runSessionPersistenceContractTests(createStore: () => SessionPersistence): void {
  // -----------------------------------------------------------------------
  // Session CRUD
  // -----------------------------------------------------------------------
  describe("session records", () => {
    test("save and load round-trip", async () => {
      const store = createStore();
      const record = makeSessionRecord({ sessionId: "s1" });
      const saveResult = await store.saveSession(record);
      expect(saveResult.ok).toBe(true);

      const loadResult = await store.loadSession("s1");
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.sessionId).toBe("s1");
        expect(loadResult.value.agentId).toBe(agentId("agent-1"));
        expect(loadResult.value.manifestSnapshot.name).toBe("test-agent");
      }
    });

    test("save overwrites existing session", async () => {
      const store = createStore();
      await store.saveSession(makeSessionRecord({ sessionId: "s1", seq: 0 }));
      await store.saveSession(makeSessionRecord({ sessionId: "s1", seq: 42 }));

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

    test("remove deletes session and its checkpoints", async () => {
      const store = createStore();
      const aid = agentId("agent-rm");
      await store.saveSession(makeSessionRecord({ sessionId: "s1", agentId: aid }));
      await store.saveCheckpoint(makeCheckpoint({ id: "cp1", agentId: aid }));

      const removeResult = await store.removeSession("s1");
      expect(removeResult.ok).toBe(true);

      const loadResult = await store.loadSession("s1");
      expect(loadResult.ok).toBe(false);

      // Checkpoints for this agent should also be gone
      const cpResult = await store.loadLatestCheckpoint(aid);
      expect(cpResult.ok).toBe(true);
      if (cpResult.ok) {
        expect(cpResult.value).toBeUndefined();
      }
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
      await store.saveSession(makeSessionRecord({ sessionId: "s1", agentId: agentId("a1") }));
      await store.saveSession(makeSessionRecord({ sessionId: "s2", agentId: agentId("a2") }));

      const result = await store.listSessions();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });

    test("listSessions filters by agentId", async () => {
      const store = createStore();
      await store.saveSession(makeSessionRecord({ sessionId: "s1", agentId: agentId("a1") }));
      await store.saveSession(makeSessionRecord({ sessionId: "s2", agentId: agentId("a2") }));

      const result = await store.listSessions({ agentId: agentId("a1") });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.sessionId).toBe("s1");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Checkpoints
  // -----------------------------------------------------------------------
  describe("checkpoints", () => {
    test("save and load latest checkpoint", async () => {
      const store = createStore();
      const aid = agentId("agent-cp");
      await store.saveCheckpoint(makeCheckpoint({ id: "cp1", agentId: aid, createdAt: 1000 }));
      await store.saveCheckpoint(makeCheckpoint({ id: "cp2", agentId: aid, createdAt: 2000 }));

      const result = await store.loadLatestCheckpoint(aid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
        expect(result.value?.id).toBe("cp2");
      }
    });

    test("loadLatestCheckpoint returns undefined for unknown agent", async () => {
      const store = createStore();
      const result = await store.loadLatestCheckpoint(agentId("unknown"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
    });

    test("listCheckpoints returns newest first", async () => {
      const store = createStore();
      const aid = agentId("agent-list");
      await store.saveCheckpoint(makeCheckpoint({ id: "cp1", agentId: aid, createdAt: 1000 }));
      await store.saveCheckpoint(makeCheckpoint({ id: "cp2", agentId: aid, createdAt: 3000 }));
      await store.saveCheckpoint(makeCheckpoint({ id: "cp3", agentId: aid, createdAt: 2000 }));

      const result = await store.listCheckpoints(aid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
        expect(result.value[0]?.id).toBe("cp2");
        expect(result.value[1]?.id).toBe("cp3");
        expect(result.value[2]?.id).toBe("cp1");
      }
    });

    test("checkpoint retention prunes oldest beyond limit", async () => {
      // Contract: stores configured with maxCheckpointsPerAgent=3
      const store = createStore();
      const aid = agentId("agent-prune");
      for (let i = 0; i < 5; i++) {
        await store.saveCheckpoint(
          makeCheckpoint({ id: `cp-${i}`, agentId: aid, createdAt: 1000 * (i + 1) }),
        );
      }

      const result = await store.listCheckpoints(aid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
        // Should keep cp-4, cp-3, cp-2 (newest 3)
        expect(result.value[0]?.id).toBe("cp-4");
        expect(result.value[1]?.id).toBe("cp-3");
        expect(result.value[2]?.id).toBe("cp-2");
      }
    });

    test("checkpoints for different agents are independent", async () => {
      const store = createStore();
      const a1 = agentId("agent-a");
      const a2 = agentId("agent-b");
      await store.saveCheckpoint(makeCheckpoint({ id: "cp-a", agentId: a1 }));
      await store.saveCheckpoint(makeCheckpoint({ id: "cp-b", agentId: a2 }));

      const r1 = await store.listCheckpoints(a1);
      const r2 = await store.listCheckpoints(a2);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.value.length).toBe(1);
        expect(r2.value.length).toBe(1);
        expect(r1.value[0]?.id).toBe("cp-a");
        expect(r2.value[0]?.id).toBe("cp-b");
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
        expect(result.value.checkpoints.size).toBe(0);
        expect(result.value.skipped).toEqual([]);
      }
    });

    test("recover returns all sessions and latest checkpoints", async () => {
      const store = createStore();
      const a1 = agentId("agent-1");
      const a2 = agentId("agent-2");

      await store.saveSession(makeSessionRecord({ sessionId: "s1", agentId: a1 }));
      await store.saveSession(makeSessionRecord({ sessionId: "s2", agentId: a2 }));

      await store.saveCheckpoint(makeCheckpoint({ id: "cp1-old", agentId: a1, createdAt: 1000 }));
      await store.saveCheckpoint(makeCheckpoint({ id: "cp1-new", agentId: a1, createdAt: 2000 }));
      await store.saveCheckpoint(makeCheckpoint({ id: "cp2", agentId: a2, createdAt: 1500 }));

      const result = await store.recover();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(2);
        expect(result.value.checkpoints.size).toBe(2);
        expect(result.value.checkpoints.get(a1)?.id).toBe("cp1-new");
        expect(result.value.checkpoints.get(a2)?.id).toBe("cp2");
        expect(result.value.skipped).toEqual([]);
      }
    });

    test("recover with 10 agents", async () => {
      const store = createStore();
      for (let i = 0; i < 10; i++) {
        const aid = agentId(`agent-${i}`);
        await store.saveSession(makeSessionRecord({ sessionId: `s-${i}`, agentId: aid }));
        await store.saveCheckpoint(makeCheckpoint({ id: `cp-${i}`, agentId: aid }));
      }

      const result = await store.recover();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(10);
        expect(result.value.checkpoints.size).toBe(10);
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
      const frame = makePendingFrame({ frameId: "f1", sessionId: "s1" });
      const result = await store.savePendingFrame(frame);
      expect(result.ok).toBe(true);

      const loadResult = await store.loadPendingFrames("s1");
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.length).toBe(1);
        expect(loadResult.value[0]?.frameId).toBe("f1");
      }
    });

    test("loadPendingFrames returns ordered by orderIndex", async () => {
      const store = createStore();
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f3", sessionId: "s1", orderIndex: 3 }),
      );
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f1", sessionId: "s1", orderIndex: 1 }),
      );
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f2", sessionId: "s1", orderIndex: 2 }),
      );

      const result = await store.loadPendingFrames("s1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
        expect(result.value[0]?.frameId).toBe("f1");
        expect(result.value[1]?.frameId).toBe("f2");
        expect(result.value[2]?.frameId).toBe("f3");
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
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f1", sessionId: "s1", orderIndex: 0 }),
      );
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f2", sessionId: "s1", orderIndex: 1 }),
      );

      const clearResult = await store.clearPendingFrames("s1");
      expect(clearResult.ok).toBe(true);

      const loadResult = await store.loadPendingFrames("s1");
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.length).toBe(0);
      }
    });

    test("clearPendingFrames does not affect other sessions", async () => {
      const store = createStore();
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f1", sessionId: "s1", orderIndex: 0 }),
      );
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f2", sessionId: "s2", orderIndex: 0 }),
      );

      await store.clearPendingFrames("s1");

      const loadResult = await store.loadPendingFrames("s2");
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.length).toBe(1);
        expect(loadResult.value[0]?.frameId).toBe("f2");
      }
    });

    test("removeSession also clears pending frames", async () => {
      const store = createStore();
      const aid = agentId("agent-pf");
      await store.saveSession(makeSessionRecord({ sessionId: "s1", agentId: aid }));
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f1", sessionId: "s1", agentId: aid, orderIndex: 0 }),
      );

      await store.removeSession("s1");

      const loadResult = await store.loadPendingFrames("s1");
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.length).toBe(0);
      }
    });

    test("removeSession cascades pending frames by agentId across sessions", async () => {
      const store = createStore();
      const aid = agentId("agent-cascade");
      // Two sessions for the same agent
      await store.saveSession(makeSessionRecord({ sessionId: "s1", agentId: aid }));
      await store.saveSession(makeSessionRecord({ sessionId: "s2", agentId: aid }));
      // Pending frames on s2 belong to the same agent
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f1", sessionId: "s2", agentId: aid, orderIndex: 0 }),
      );

      // Remove s1 — should cascade pending frames for agent across ALL sessions
      await store.removeSession("s1");

      const loadResult = await store.loadPendingFrames("s2");
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.length).toBe(0);
      }
    });

    test("recover includes pending frames", async () => {
      const store = createStore();
      const aid = agentId("agent-recover-pf");
      await store.saveSession(makeSessionRecord({ sessionId: "s1", agentId: aid }));
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f1", sessionId: "s1", agentId: aid, orderIndex: 0 }),
      );
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f2", sessionId: "s1", agentId: aid, orderIndex: 1 }),
      );

      const result = await store.recover();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pendingFrames.size).toBe(1);
        const frames = result.value.pendingFrames.get("s1");
        expect(frames).toBeDefined();
        expect(frames?.length).toBe(2);
        expect(result.value.skipped).toEqual([]);
      }
    });

    test("removePendingFrame removes single frame", async () => {
      const store = createStore();
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f1", sessionId: "s1", orderIndex: 0 }),
      );
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f2", sessionId: "s1", orderIndex: 1 }),
      );

      const removeResult = await store.removePendingFrame("f1");
      expect(removeResult.ok).toBe(true);

      const loadResult = await store.loadPendingFrames("s1");
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.length).toBe(1);
        expect(loadResult.value[0]?.frameId).toBe("f2");
      }
    });

    test("removePendingFrame for unknown frameId is no-op", async () => {
      const store = createStore();
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f1", sessionId: "s1", orderIndex: 0 }),
      );

      const removeResult = await store.removePendingFrame("nonexistent");
      expect(removeResult.ok).toBe(true);

      const loadResult = await store.loadPendingFrames("s1");
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.length).toBe(1);
      }
    });

    test("savePendingFrame upserts retryCount", async () => {
      const store = createStore();
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f1", sessionId: "s1", orderIndex: 0, retryCount: 0 }),
      );

      // Upsert with incremented retryCount
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f1", sessionId: "s1", orderIndex: 0, retryCount: 3 }),
      );

      const loadResult = await store.loadPendingFrames("s1");
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.length).toBe(1);
        expect(loadResult.value[0]?.retryCount).toBe(3);
      }
    });

    test("pending frame preserves payload round-trip", async () => {
      const store = createStore();
      const payload = { nested: { data: [1, 2, 3] }, flag: true };
      await store.savePendingFrame(
        makePendingFrame({ frameId: "f1", sessionId: "s1", payload, orderIndex: 0 }),
      );

      const result = await store.loadPendingFrames("s1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value[0]?.payload).toEqual(payload);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Validation errors
  // -----------------------------------------------------------------------
  describe("validation", () => {
    test("saveSession rejects empty session ID", async () => {
      const store = createStore();
      const result = await store.saveSession(makeSessionRecord({ sessionId: "" }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("saveSession rejects empty agent ID", async () => {
      const store = createStore();
      const result = await store.saveSession(
        makeSessionRecord({ sessionId: "s1", agentId: agentId("") }),
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

    test("saveCheckpoint rejects empty checkpoint ID", async () => {
      const store = createStore();
      const result = await store.saveCheckpoint(
        makeCheckpoint({ id: "", agentId: agentId("agent-1") }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("saveCheckpoint rejects empty agent ID", async () => {
      const store = createStore();
      const result = await store.saveCheckpoint(
        makeCheckpoint({ id: "cp1", agentId: agentId("") }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("loadLatestCheckpoint rejects empty agent ID", async () => {
      const store = createStore();
      const result = await store.loadLatestCheckpoint(agentId(""));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("listCheckpoints rejects empty agent ID", async () => {
      const store = createStore();
      const result = await store.listCheckpoints(agentId(""));
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
    test("engine state with null data", async () => {
      const store = createStore();
      const aid = agentId("agent-null");
      const nullState: EngineState = { engineId: "test", data: null };
      await store.saveCheckpoint(
        makeCheckpoint({ id: "cp-null", agentId: aid, engineState: nullState }),
      );

      const result = await store.loadLatestCheckpoint(aid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value?.engineState.data).toBeNull();
      }
    });

    test("engine state with large data (>1MB JSON)", async () => {
      const store = createStore();
      const aid = agentId("agent-large");
      const largeData = {
        messages: Array.from({ length: 10000 }, (_, i) => ({
          role: "assistant",
          content: `Message ${i}: ${"x".repeat(100)}`,
        })),
      };
      const largeState: EngineState = { engineId: "test", data: largeData };
      await store.saveCheckpoint(
        makeCheckpoint({ id: "cp-large", agentId: aid, engineState: largeState }),
      );

      const result = await store.loadLatestCheckpoint(aid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.value?.engineState.data as typeof largeData;
        expect(data.messages.length).toBe(10000);
      }
    });

    test("unicode in metadata", async () => {
      const store = createStore();
      const aid = agentId("agent-unicode");
      await store.saveSession(
        makeSessionRecord({
          sessionId: "s-unicode",
          agentId: aid,
          metadata: { name: "工具-名前-도구", emoji: "🤖" },
        }),
      );

      const result = await store.loadSession("s-unicode");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metadata).toEqual({ name: "工具-名前-도구", emoji: "🤖" });
      }
    });

    test("concurrent saves for different agents do not interfere", async () => {
      const store = createStore();
      const saves = Array.from({ length: 10 }, (_, i) => {
        const aid = agentId(`concurrent-${i}`);
        return store.saveCheckpoint(
          makeCheckpoint({ id: `cp-c-${i}`, agentId: aid, createdAt: Date.now() + i }),
        );
      });
      const results = await Promise.all(saves);
      for (const r of results) {
        expect(r.ok).toBe(true);
      }

      // Each agent should have exactly 1 checkpoint
      for (let i = 0; i < 10; i++) {
        const aid = agentId(`concurrent-${i}`);
        const cpResult = await store.loadLatestCheckpoint(aid);
        expect(cpResult.ok).toBe(true);
        if (cpResult.ok) {
          expect(cpResult.value?.id).toBe(`cp-c-${i}`);
        }
      }
    });

    test("overwrite session then recover returns latest", async () => {
      const store = createStore();
      const aid = agentId("agent-overwrite");
      await store.saveSession(makeSessionRecord({ sessionId: "s1", agentId: aid, seq: 1 }));
      await store.saveSession(makeSessionRecord({ sessionId: "s1", agentId: aid, seq: 99 }));

      const result = await store.recover();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(1);
        expect(result.value.sessions[0]?.seq).toBe(99);
        expect(result.value.skipped).toEqual([]);
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
}
