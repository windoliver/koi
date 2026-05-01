/**
 * Tests for wrapAdapterWithStatePersistence — issue #1683.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentManifest,
  EngineAdapter,
  EngineCapabilities,
  EngineEvent,
  EngineInput,
  EngineState,
  SessionPersistence,
} from "@koi/core";
import { agentId, sessionId } from "@koi/core";
import {
  type SessionRecordTemplate,
  wrapAdapterWithStatePersistence,
} from "./persist-engine-state.js";
import { createInMemorySessionPersistence } from "./persistence/memory-store.js";

const manifest: AgentManifest = {
  name: "test-agent",
  version: "0.1.0",
  description: "test",
  model: { name: "test-model" },
};

const SID = sessionId("s-1683");

function template(): SessionRecordTemplate {
  return {
    sessionId: SID,
    agentId: agentId("agent-1683"),
    manifestSnapshot: manifest,
    seq: 7,
    remoteSeq: 3,
    connectedAt: 1_000,
    status: "idle",
    metadata: {},
  };
}

const caps: EngineCapabilities = { text: true, images: false, files: false, audio: false };

function makeAdapter(events: readonly EngineEvent[], state?: EngineState): EngineAdapter {
  const stream = (_input: EngineInput): AsyncIterable<EngineEvent> => {
    return (async function* (): AsyncIterable<EngineEvent> {
      for (const e of events) yield e;
    })();
  };
  const base: EngineAdapter = { engineId: "test-engine", capabilities: caps, stream };
  return state !== undefined
    ? { ...base, saveState: async (): Promise<EngineState> => state }
    : base;
}

const interruptedDone: EngineEvent = {
  kind: "done",
  output: {
    content: [],
    stopReason: "interrupted",
    metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
  },
};
const completedDone: EngineEvent = {
  kind: "done",
  output: {
    content: [],
    stopReason: "completed",
    metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
  },
};

const captured: EngineState = { engineId: "test-engine", data: { cursor: 42 } };

describe("wrapAdapterWithStatePersistence", () => {
  let store: SessionPersistence;
  beforeEach(() => {
    store = createInMemorySessionPersistence();
  });

  test("interrupted terminal persists EngineState into SessionPersistence", async () => {
    const inner = makeAdapter([{ kind: "text_delta", delta: "hi" }, interruptedDone], captured);
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: store,
      recordTemplate: template,
      now: () => 5_000,
    });

    const events: EngineEvent[] = [];
    for await (const e of wrapped.stream({ kind: "text", text: "hi" })) events.push(e);
    expect(events).toHaveLength(2);

    const loaded = await store.loadSession(SID);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("unreachable");
    expect(loaded.value.lastEngineState).toEqual(captured);
    expect(loaded.value.lastPersistedAt).toBe(5_000);
    expect(loaded.value.seq).toBe(7);
    expect(loaded.value.status).toBe("idle");
  });

  test("non-interrupted terminal does NOT persist", async () => {
    const inner = makeAdapter([completedDone], captured);
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: store,
      recordTemplate: template,
    });
    for await (const _ of wrapped.stream({ kind: "text", text: "hi" }));

    const loaded = await store.loadSession(SID);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("NOT_FOUND");
  });

  test("adapter without saveState is returned unchanged (transcript fallback)", async () => {
    const inner = makeAdapter([interruptedDone]);
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: store,
      recordTemplate: template,
    });
    expect(wrapped).toBe(inner);
    for await (const _ of wrapped.stream({ kind: "text", text: "hi" }));

    const loaded = await store.loadSession(SID);
    expect(loaded.ok).toBe(false);
  });

  test("saveState throw routes through onPersistError; stream still completes", async () => {
    const base = makeAdapter([interruptedDone]);
    const inner: EngineAdapter = {
      ...base,
      saveState: async () => {
        throw new Error("disk full");
      },
    };
    const onError = mock(() => {});
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: store,
      recordTemplate: template,
      onPersistError: onError,
    });

    const events: EngineEvent[] = [];
    for await (const e of wrapped.stream({ kind: "text", text: "hi" })) events.push(e);
    expect(events).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("saveSession failure routes through onPersistError", async () => {
    const failingStore: SessionPersistence = {
      ...store,
      saveSession: async () => ({
        ok: false,
        error: {
          code: "INTERNAL",
          message: "store offline",
          retryable: true,
          context: {},
        },
      }),
    };
    const inner = makeAdapter([interruptedDone], captured);
    const onError = mock(() => {});
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: failingStore,
      recordTemplate: template,
      onPersistError: onError,
    });

    for await (const _ of wrapped.stream({ kind: "text", text: "hi" }));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("recordTemplate is invoked at terminal time, not at wrap time", async () => {
    let currentSeq = 0;
    const dynamicTemplate = (): SessionRecordTemplate => ({ ...template(), seq: currentSeq });
    const inner = makeAdapter([interruptedDone], captured);
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: store,
      recordTemplate: dynamicTemplate,
    });
    currentSeq = 99; // mutated after wrapping, before stream

    for await (const _ of wrapped.stream({ kind: "text", text: "hi" }));

    const loaded = await store.loadSession(SID);
    if (!loaded.ok) throw new Error("expected ok");
    expect(loaded.value.seq).toBe(99);
  });
});
