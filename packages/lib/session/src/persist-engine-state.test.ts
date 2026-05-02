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

// Tests that don't care about persist errors get a no-op handler. Tests
// that DO assert on errors override this with their own collector below.
const noopOnPersistError: (e: KoiError | Error) => void = () => {};

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
      onPersistError: noopOnPersistError,
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
      onPersistError: noopOnPersistError,
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
      onPersistError: noopOnPersistError,
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
      onPersistError: noopOnPersistError,
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
      onPersistError: noopOnPersistError,
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
      onPersistError: noopOnPersistError,
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
      onPersistError: noopOnPersistError,
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

  test("error terminal clears the prior cancel checkpoint (transcript advanced past it)", async () => {
    // Cancel once → row has lastEngineState.
    const cancelWrap = wrapAdapterWithStatePersistence(makeAdapter([interruptedDone], captured), {
      persistence: store,
      recordTemplate: template,
      onPersistError: noopOnPersistError,
    });
    for await (const _ of cancelWrap.stream({ kind: "text", text: "hi" }));

    // Any non-interrupted terminal advances the transcript past the cancel
    // cursor, so the saved EngineState is no longer coherent. The wrapper
    // must drop it to prevent the next resume from replaying stale state
    // against an extended transcript.
    const errorDone: EngineEvent = {
      kind: "done",
      output: {
        content: [],
        stopReason: "error",
        metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
      },
    };
    const errorWrap = wrapAdapterWithStatePersistence(makeAdapter([errorDone], captured), {
      persistence: store,
      recordTemplate: template,
      onPersistError: noopOnPersistError,
    });
    for await (const _ of errorWrap.stream({ kind: "text", text: "hi" }));

    const loaded = await store.loadSession(SID);
    if (!loaded.ok) throw new Error("expected ok");
    expect(loaded.value.lastEngineState).toBeUndefined();
  });

  test("max_turns terminal clears the prior cancel checkpoint", async () => {
    const cancelWrap = wrapAdapterWithStatePersistence(makeAdapter([interruptedDone], captured), {
      persistence: store,
      recordTemplate: template,
      onPersistError: noopOnPersistError,
    });
    for await (const _ of cancelWrap.stream({ kind: "text", text: "hi" }));

    const maxTurnsDone: EngineEvent = {
      kind: "done",
      output: {
        content: [],
        stopReason: "max_turns",
        metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
      },
    };
    const wrap = wrapAdapterWithStatePersistence(makeAdapter([maxTurnsDone], captured), {
      persistence: store,
      recordTemplate: template,
      onPersistError: noopOnPersistError,
    });
    for await (const _ of wrap.stream({ kind: "text", text: "hi" }));

    const loaded = await store.loadSession(SID);
    if (!loaded.ok) throw new Error("expected ok");
    expect(loaded.value.lastEngineState).toBeUndefined();
  });

  test("late-finishing timed-out persist does NOT overwrite a newer terminal's state", async () => {
    // Adapter saveState is slow (resolves after the timeout fires). The
    // wrapper must not let that late write commit on top of a subsequent
    // completed terminal that already cleared the checkpoint.
    let releaseSaveState: ((state: EngineState) => void) | undefined;
    const slowSavePromise = new Promise<EngineState>((resolve) => {
      releaseSaveState = resolve;
    });

    const inner: EngineAdapter = {
      ...makeAdapter([interruptedDone, completedDone]),
      saveState: () => slowSavePromise,
    };
    const errors: Array<KoiError | Error> = [];
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: store,
      recordTemplate: template,
      persistTimeoutMs: 30,
      onPersistError: (e) => errors.push(e),
    });

    // Drain both terminals: interrupt first (will time out), then completed.
    for await (const _ of wrapped.stream({ kind: "text", text: "hi" }));

    // Interrupt timed out; completed had no prior checkpoint to clear.
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const noRowYet = await store.loadSession(SID);
    expect(noRowYet.ok).toBe(false);

    // Now release the late saveState — its merge attempt must drop because
    // the generation has advanced past it.
    releaseSaveState?.(captured);
    await new Promise((r) => setTimeout(r, 20));

    const finalRow = await store.loadSession(SID);
    expect(finalRow.ok).toBe(false); // no late write resurrected the checkpoint
  });

  test("uses updateLastEngineState when available (atomic CAS path)", async () => {
    // Pre-create the row so the atomic update has a target.
    await store.saveSession({ ...template(), lastPersistedAt: 1 });
    const calls: Array<EngineState | undefined> = [];
    const trackingStore: SessionPersistence = {
      ...store,
      updateLastEngineState: async (sid, apply, nowMs) => {
        const r = await store.updateLastEngineState?.(
          sid,
          (prev) => {
            const next = apply(prev);
            calls.push(next);
            return next;
          },
          nowMs,
        );
        return r ?? { ok: true, value: undefined };
      },
    };
    const wrapped = wrapAdapterWithStatePersistence(makeAdapter([interruptedDone], captured), {
      persistence: trackingStore,
      recordTemplate: template,
      onPersistError: noopOnPersistError,
    });
    for await (const _ of wrapped.stream({ kind: "text", text: "hi" }));

    expect(calls).toEqual([captured]);
    const loaded = await store.loadSession(SID);
    if (!loaded.ok) throw new Error("expected ok");
    expect(loaded.value.lastEngineState).toEqual(captured);
  });

  test("late timed-out persist from prior stream() call does NOT clobber a later stream's state", async () => {
    // Production sessions reuse one wrapper across many stream() invocations.
    // A slow saveState from stream-1 must not race past stream-2's clear.
    let releaseStream1Save: ((s: EngineState) => void) | undefined;
    const slow = new Promise<EngineState>((r) => {
      releaseStream1Save = r;
    });

    const events1 = (async function* (): AsyncIterable<EngineEvent> {
      yield interruptedDone;
    })();
    const events2 = (async function* (): AsyncIterable<EngineEvent> {
      yield completedDone;
    })();

    let streamCallCount = 0;
    const inner: EngineAdapter = {
      engineId: "test-engine",
      capabilities: caps,
      stream: () => (streamCallCount++ === 0 ? events1 : events2),
      saveState: () => slow,
    };
    const errors: Array<KoiError | Error> = [];
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: store,
      recordTemplate: template,
      persistTimeoutMs: 30,
      onPersistError: (e) => errors.push(e),
    });

    // Stream 1: interrupted; saveState hangs and times out.
    for await (const _ of wrapped.stream({ kind: "text", text: "a" }));
    expect(errors.length).toBeGreaterThanOrEqual(1);

    // Stream 2: completed terminal advances the wrapper-level generation.
    for await (const _ of wrapped.stream({ kind: "text", text: "b" }));

    // Now release the stream-1 saveState; its merge path must drop because
    // the shared generation has advanced.
    releaseStream1Save?.(captured);
    await new Promise((r) => setTimeout(r, 20));

    const final = await store.loadSession(SID);
    // Either the row was never written (stream 2 had nothing to clear) or it
    // exists with no lastEngineState — what we forbid is a stale resurrect.
    if (final.ok) expect(final.value.lastEngineState).toBeUndefined();
  });

  test("hung saveState does NOT block cancel terminal beyond persistTimeoutMs", async () => {
    const inner: EngineAdapter = {
      ...makeAdapter([interruptedDone]),
      saveState: () => new Promise<EngineState>(() => {}), // never resolves
    };
    const errors: Array<KoiError | Error> = [];
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: store,
      recordTemplate: template,
      persistTimeoutMs: 50,
      onPersistError: (e) => errors.push(e),
    });

    const startedAt = Date.now();
    const events: EngineEvent[] = [];
    for await (const e of wrapped.stream({ kind: "text", text: "hi" })) events.push(e);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2_000);
    expect(events.at(-1)?.kind).toBe("done");
    expect(errors).toHaveLength(1);
    const e0 = errors[0];
    expect(e0?.message ?? "").toContain("deadline");
  });

  test("recordTemplate is invoked at terminal time, not at wrap time", async () => {
    let currentSeq = 0;
    const dynamicTemplate = (): SessionRecordTemplate => ({ ...template(), seq: currentSeq });
    const inner = makeAdapter([interruptedDone], captured);
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: store,
      recordTemplate: dynamicTemplate,
      onPersistError: noopOnPersistError,
    });
    currentSeq = 99; // mutated after wrapping, before stream

    for await (const _ of wrapped.stream({ kind: "text", text: "hi" }));

    const loaded = await store.loadSession(SID);
    if (!loaded.ok) throw new Error("expected ok");
    expect(loaded.value.seq).toBe(99);
  });

  test("initialEngineState is applied via inner.loadState exactly once before first stream", async () => {
    const loaded: EngineState[] = [];
    const inner: EngineAdapter = {
      ...makeAdapter([completedDone], captured),
      loadState: async (s) => {
        loaded.push(s);
      },
    };
    const initial: EngineState = { engineId: "test-engine", data: { resumed: true } };
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: store,
      recordTemplate: template,
      onPersistError: noopOnPersistError,
      initialEngineState: initial,
    });
    for await (const _ of wrapped.stream({ kind: "text", text: "a" }));
    for await (const _ of wrapped.stream({ kind: "text", text: "b" }));
    expect(loaded).toEqual([initial]);
  });

  test("initialEngineState loadState failure routes through onPersistError; stream still runs", async () => {
    const inner: EngineAdapter = {
      ...makeAdapter([completedDone], captured),
      loadState: async () => {
        throw new Error("decode failed");
      },
    };
    const errors: Array<KoiError | Error> = [];
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: store,
      recordTemplate: template,
      onPersistError: (e) => errors.push(e),
      initialEngineState: { engineId: "test-engine", data: {} },
    });
    const events: EngineEvent[] = [];
    for await (const e of wrapped.stream({ kind: "text", text: "hi" })) events.push(e);
    expect(errors).toHaveLength(1);
    expect(events.at(-1)?.kind).toBe("done");
  });

  test("CAS backoff: cancel write skips when another runtime wrote to the row first", async () => {
    // Resume scenario: wrapper is seeded with the lastPersistedAt it
    // observed at load time. Between resume and the first cancel, ANOTHER
    // runtime (e.g. a parallel TUI on the same SQLite db) writes a newer
    // checkpoint. Our wrapper's cancel write must NOT clobber that newer
    // state — the CAS precondition fires CONFLICT, signal goes through
    // onPersistError, persisted row stays as the other runtime left it.
    const otherState: EngineState = { engineId: "test-engine", data: { from: "other" } };
    await store.saveSession({
      ...template(),
      lastEngineState: { engineId: "test-engine", data: { from: "ours" } },
      lastPersistedAt: 1_000,
    });
    // Wrapper resumes seeded with version 1_000 (what we observed).
    const errors: Array<KoiError | Error> = [];
    const wrapped = wrapAdapterWithStatePersistence(makeAdapter([interruptedDone], captured), {
      persistence: store,
      recordTemplate: template,
      onPersistError: (e) => errors.push(e),
      initialEngineStateVersion: 1_000,
    });
    // Simulate the other runtime writing in between (lastPersistedAt advances).
    await store.saveSession({
      ...template(),
      lastEngineState: otherState,
      lastPersistedAt: 5_000,
    });
    // Now our cancel fires.
    for await (const _ of wrapped.stream({ kind: "text", text: "hi" }));

    expect(errors).toHaveLength(1);
    const e0 = errors[0];
    if (e0 !== undefined && "code" in e0) {
      expect(e0.code).toBe("CONFLICT");
    } else {
      throw new Error("expected KoiError with CONFLICT");
    }
    // The other runtime's state survives — we did NOT clobber it.
    const after = await store.loadSession(SID);
    if (!after.ok) throw new Error("expected ok");
    expect(after.value.lastEngineState).toEqual(otherState);
    expect(after.value.lastPersistedAt).toBe(5_000);
  });

  test("transient loadState failure preserves the persisted checkpoint (one-shot clear shield)", async () => {
    // Seed a persisted checkpoint as if a prior cancel had written it.
    await store.saveSession({
      ...template(),
      lastEngineState: captured,
      lastPersistedAt: 1,
    });

    // loadState throws — host gets onPersistError signal but the
    // persisted row is preserved so the host can retry resume against
    // the same checkpoint. One-shot: the NEXT non-interrupted terminal
    // (without an intervening successful load) DOES clear.
    const inner: EngineAdapter = {
      ...makeAdapter([completedDone], captured),
      loadState: async () => {
        throw new Error("transient decode failure");
      },
    };
    const errors: Array<KoiError | Error> = [];
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: store,
      recordTemplate: template,
      onPersistError: (e) => errors.push(e),
      initialEngineState: captured,
    });
    for await (const _ of wrapped.stream({ kind: "text", text: "hi" }));

    expect(errors).toHaveLength(1);
    const after = await store.loadSession(SID);
    if (!after.ok) throw new Error("expected ok");
    // Checkpoint preserved — host can retry against the same row.
    expect(after.value.lastEngineState).toEqual(captured);
    // Durable poison marker written so a SECOND attempt converges by
    // clearing the checkpoint instead of preserving forever.
    expect(typeof after.value.metadata.__koi_loadFailedAt).toBe("number");
  });

  test("second consecutive loadState failure clears the poisoned checkpoint (cross-process convergence)", async () => {
    // Pre-existing row carries the marker from a prior process's failure.
    await store.saveSession({
      ...template(),
      lastEngineState: captured,
      lastPersistedAt: 1,
      metadata: { ...template().metadata, __koi_loadFailedAt: 1 },
    });

    const inner: EngineAdapter = {
      ...makeAdapter([completedDone], captured),
      loadState: async () => {
        throw new Error("still broken in this fresh process");
      },
    };
    const errors: Array<KoiError | Error> = [];
    const wrapped = wrapAdapterWithStatePersistence(inner, {
      persistence: store,
      recordTemplate: template,
      onPersistError: (e) => errors.push(e),
      initialEngineState: captured,
    });
    for await (const _ of wrapped.stream({ kind: "text", text: "hi" }));

    const after = await store.loadSession(SID);
    if (!after.ok) throw new Error("expected ok");
    // Checkpoint cleared so the next resume falls back to transcript-only
    // instead of preserving a broken cursor forever across restarts.
    expect(after.value.lastEngineState).toBeUndefined();
    // Marker dropped along with the cleared checkpoint — a future fresh
    // checkpoint that fails to load starts the cycle from scratch.
    expect("__koi_loadFailedAt" in after.value.metadata).toBe(false);
  });
});
