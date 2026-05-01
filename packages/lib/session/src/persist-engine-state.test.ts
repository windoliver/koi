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
  KoiError,
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

  test("non-interrupted terminal on never-written session does NOT create a row", async () => {
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

  test("interrupt then successful terminal clears the stale checkpoint", async () => {
    // Cancel once → row exists with lastEngineState set.
    const cancelAdapter = makeAdapter([interruptedDone], captured);
    const cancelWrap = wrapAdapterWithStatePersistence(cancelAdapter, {
      persistence: store,
      recordTemplate: template,
    });
    for await (const _ of cancelWrap.stream({ kind: "text", text: "hi" }));
    const afterCancel = await store.loadSession(SID);
    if (!afterCancel.ok) throw new Error("expected ok");
    expect(afterCancel.value.lastEngineState).toEqual(captured);

    // Successful turn on the same session → checkpoint must be cleared.
    const successAdapter = makeAdapter([completedDone], captured);
    const successWrap = wrapAdapterWithStatePersistence(successAdapter, {
      persistence: store,
      recordTemplate: template,
    });
    for await (const _ of successWrap.stream({ kind: "text", text: "hi" }));
    const afterSuccess = await store.loadSession(SID);
    if (!afterSuccess.ok) throw new Error("expected ok");
    expect(afterSuccess.value.lastEngineState).toBeUndefined();
  });

  test("interrupt persistence merges into existing row instead of overwriting unrelated fields", async () => {
    // Pre-existing row with caller-managed counters and metadata.
    await store.saveSession({
      ...template(),
      seq: 50,
      remoteSeq: 25,
      metadata: { route: "vip" },
      lastPersistedAt: 1,
    });

    // Wrapper template lags behind (e.g. caller hasn't refreshed since wrap).
    const staleTemplate = (): SessionRecordTemplate => ({
      ...template(),
      seq: 0,
      remoteSeq: 0,
      metadata: {},
    });
    const inner = makeAdapter([interruptedDone], captured);
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: store,
      recordTemplate: staleTemplate,
      now: () => 9_999,
    });
    for await (const _ of wrapped.stream({ kind: "text", text: "hi" }));

    const loaded = await store.loadSession(SID);
    if (!loaded.ok) throw new Error("expected ok");
    expect(loaded.value.lastEngineState).toEqual(captured);
    expect(loaded.value.lastPersistedAt).toBe(9_999);
    // Unrelated fields preserved from the existing row.
    expect(loaded.value.seq).toBe(50);
    expect(loaded.value.remoteSeq).toBe(25);
    expect(loaded.value.metadata).toEqual({ route: "vip" });
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

  test("consumer that breaks immediately after `done` still observes a persisted checkpoint", async () => {
    // Mirrors the production cancel path: workers exit the for-await loop the
    // moment they see the interrupted terminal and never pull the trailing
    // sentinel. The wrapper must run its side effect BEFORE yielding `done`.
    const inner = makeAdapter(
      [{ kind: "text_delta", delta: "partial" }, interruptedDone],
      captured,
    );
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: store,
      recordTemplate: template,
    });

    for await (const e of wrapped.stream({ kind: "text", text: "hi" })) {
      if (e.kind === "done") break; // do NOT pull the next iterator step
    }

    const loaded = await store.loadSession(SID);
    if (!loaded.ok) throw new Error("checkpoint missing — persist ran after yield");
    expect(loaded.value.lastEngineState).toEqual(captured);
  });

  test("caller can detect checkpoint loss in-band via onPersistError (no stderr scraping)", async () => {
    // Simulates a transient store outage. The contract is: the cancel still
    // produces an interrupted terminal AND the supplied callback fires with a
    // typed error so the host can downgrade the resume UX.
    const failingStore: SessionPersistence = {
      ...store,
      saveSession: async () => ({
        ok: false,
        error: { code: "INTERNAL", message: "store offline", retryable: true, context: {} },
      }),
    };
    const inner = makeAdapter([interruptedDone], captured);
    const errors: Array<KoiError | Error> = [];
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: failingStore,
      recordTemplate: template,
      onPersistError: (e) => errors.push(e),
    });

    const events: EngineEvent[] = [];
    for await (const e of wrapped.stream({ kind: "text", text: "hi" })) events.push(e);

    expect(events.at(-1)?.kind).toBe("done");
    expect(errors).toHaveLength(1);
    const e0 = errors[0];
    if (e0 !== undefined && "code" in e0) {
      expect(e0.code).toBe("INTERNAL");
    } else {
      throw new Error("expected KoiError");
    }
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
