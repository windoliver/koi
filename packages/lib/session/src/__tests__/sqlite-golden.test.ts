/**
 * Golden: @koi/session — session-recovery (decision 12-B)
 *
 * Standalone golden query: tests crash recovery integration without LLM.
 * Verifies that 3 sessions + pending frames survive a simulated restart via recover().
 */

import { describe, expect, test } from "bun:test";
import { agentId, sessionId } from "@koi/core";
import { createSqliteSessionPersistence } from "../persistence/sqlite-store.js";

describe("Golden: @koi/session — session recovery", () => {
  test("recover() returns all sessions + pending frames after simulated restart", () => {
    // Step 1: populate the store (first "process" lifecycle)
    const store = createSqliteSessionPersistence({ dbPath: ":memory:" });

    const manifest = { name: "recovery-agent", version: "1.0.0", model: { name: "gpt" } };
    const now = Date.now();

    // Save 3 sessions for 2 different agents
    store.saveSession({
      sessionId: sessionId("s1"),
      agentId: agentId("agent-alpha"),
      manifestSnapshot: manifest,
      seq: 5,
      remoteSeq: 3,
      connectedAt: now - 10000,
      lastPersistedAt: now - 1000,
      metadata: { channel: "cli" },
    });
    store.saveSession({
      sessionId: sessionId("s2"),
      agentId: agentId("agent-alpha"),
      manifestSnapshot: manifest,
      seq: 2,
      remoteSeq: 1,
      connectedAt: now - 5000,
      lastPersistedAt: now - 500,
      metadata: {},
    });
    store.saveSession({
      sessionId: sessionId("s3"),
      agentId: agentId("agent-beta"),
      manifestSnapshot: manifest,
      seq: 1,
      remoteSeq: 0,
      connectedAt: now - 3000,
      lastPersistedAt: now - 300,
      metadata: {},
    });

    // Save 2 pending frames for s1 (unsent before crash)
    store.savePendingFrame({
      frameId: "frame-a",
      sessionId: sessionId("s1"),
      agentId: agentId("agent-alpha"),
      frameType: "agent:message",
      payload: { text: "unsent message A" },
      orderIndex: 0,
      createdAt: now - 800,
      retryCount: 1,
    });
    store.savePendingFrame({
      frameId: "frame-b",
      sessionId: sessionId("s1"),
      agentId: agentId("agent-alpha"),
      frameType: "agent:message",
      payload: { text: "unsent message B" },
      orderIndex: 1,
      createdAt: now - 700,
      retryCount: 0,
    });

    // Step 2: recover (simulates next process startup reading the same DB)
    const result = store.recover();

    // Recovery is synchronous for SQLite
    expect("then" in result).toBe(false);
    if ("then" in result) return;

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const plan = result.value;

    // All 3 sessions recovered
    expect(plan.sessions.length).toBe(3);
    expect(plan.skipped).toEqual([]);

    // s1 seq preserved
    const s1 = plan.sessions.find((s) => s.sessionId === "s1");
    expect(s1?.seq).toBe(5);
    expect(s1?.metadata).toEqual({ channel: "cli" });

    // 2 pending frames for s1, ordered by orderIndex
    const frames = plan.pendingFrames.get("s1");
    expect(frames?.length).toBe(2);
    expect(frames?.[0]?.frameId).toBe("frame-a");
    expect(frames?.[0]?.orderIndex).toBe(0);
    expect(frames?.[1]?.frameId).toBe("frame-b");
    expect(frames?.[1]?.orderIndex).toBe(1);
    expect(frames?.[0]?.payload).toEqual({ text: "unsent message A" });

    // No frames for s2 or s3
    expect(plan.pendingFrames.has("s2")).toBe(false);
    expect(plan.pendingFrames.has("s3")).toBe(false);

    store.close();
  });

  test("recover() with engine state preserved across restart", () => {
    const store = createSqliteSessionPersistence({ dbPath: ":memory:" });
    const manifest = { name: "stateful-agent", version: "1.0.0", model: { name: "m" } };

    store.saveSession({
      sessionId: sessionId("s-stateful"),
      agentId: agentId("agent-1"),
      manifestSnapshot: manifest,
      seq: 10,
      remoteSeq: 8,
      connectedAt: Date.now() - 5000,
      lastPersistedAt: Date.now() - 100,
      metadata: {},
      lastEngineState: {
        engineId: "langgraph-v2",
        data: { messages: ["hello", "world"], step: 10 },
      },
    });

    const result = store.recover();
    if ("then" in result) return;
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const session = result.value.sessions[0];
    expect(session?.lastEngineState?.engineId).toBe("langgraph-v2");
    expect(session?.lastEngineState?.data).toEqual({
      messages: ["hello", "world"],
      step: 10,
    });

    store.close();
  });
});
