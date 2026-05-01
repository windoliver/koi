/**
 * Tests for resumeWithEngineState — issue #1683.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineState,
  SessionPersistence,
  SessionRecord,
  SessionTranscript,
} from "@koi/core";
import { agentId, sessionId } from "@koi/core";
import { createInMemorySessionPersistence } from "../persistence/memory-store.js";
import { resumeWithEngineState } from "../resume.js";
import { createInMemoryTranscript } from "../transcript/memory-store.js";

const manifest: AgentManifest = {
  name: "t",
  version: "0.1.0",
  description: "t",
  model: { name: "m" },
};

const SID = sessionId("s-state");

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: SID,
    agentId: agentId("a"),
    manifestSnapshot: manifest,
    seq: 0,
    remoteSeq: 0,
    connectedAt: 0,
    lastPersistedAt: 0,
    status: "idle",
    metadata: {},
    ...overrides,
  };
}

describe("resumeWithEngineState", () => {
  let store: SessionPersistence;
  let transcript: SessionTranscript;
  beforeEach(() => {
    store = createInMemorySessionPersistence();
    transcript = createInMemoryTranscript();
  });

  test("returns lastEngineState when engineId matches expected", async () => {
    const state: EngineState = { engineId: "e", data: { step: 5 } };
    await store.saveSession(makeRecord({ lastEngineState: state }));

    const result = await resumeWithEngineState(SID, transcript, store, {
      expectedEngineId: "e",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.value.lastEngineState).toEqual(state);
    expect(result.value.messages).toEqual([]);
  });

  test("drops persisted state whose engineId does not match (adapter swap / version skew)", async () => {
    const state: EngineState = { engineId: "old-engine-v1", data: { step: 5 } };
    await store.saveSession(makeRecord({ lastEngineState: state }));

    const mismatches: Array<[EngineState, string]> = [];
    const result = await resumeWithEngineState(SID, transcript, store, {
      expectedEngineId: "new-engine-v2",
      onEngineMismatch: (s, expected) => mismatches.push([s, expected]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.value.lastEngineState).toBeUndefined();
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.[0].engineId).toBe("old-engine-v1");
    expect(mismatches[0]?.[1]).toBe("new-engine-v2");
  });

  test("missing session record falls back to undefined state (transcript-only)", async () => {
    const result = await resumeWithEngineState(SID, transcript, store, {
      expectedEngineId: "e",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.value.lastEngineState).toBeUndefined();
  });

  test("session record without lastEngineState yields undefined state", async () => {
    await store.saveSession(makeRecord());
    const result = await resumeWithEngineState(SID, transcript, store, {
      expectedEngineId: "e",
    });
    if (!result.ok) throw new Error();
    expect(result.value.lastEngineState).toBeUndefined();
  });

  test("propagates non-NOT_FOUND persistence errors", async () => {
    const failing: SessionPersistence = {
      ...store,
      loadSession: async () => ({
        ok: false,
        error: { code: "INTERNAL", message: "boom", retryable: true, context: {} },
      }),
    };
    const result = await resumeWithEngineState(SID, transcript, failing, {
      expectedEngineId: "e",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error.code).toBe("INTERNAL");
  });

  test("propagates transcript validation error (empty session id)", async () => {
    const result = await resumeWithEngineState(sessionId(""), transcript, store, {
      expectedEngineId: "e",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error.code).toBe("VALIDATION");
  });
});
