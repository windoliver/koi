import { describe, expect, mock, spyOn, test } from "bun:test";
import type { EngineEvent } from "@koi/core/engine";
import { createInitialState } from "./initial.js";
import { createStore } from "./store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): ReturnType<typeof createStore> {
  return createStore(createInitialState());
}

/** Flush pending microtasks so batched notifications fire. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// getState / dispatch basics
// ---------------------------------------------------------------------------

describe("TuiStore — getState", () => {
  test("returns initial state", () => {
    const store = makeStore();
    expect(store.getState()).toEqual(createInitialState());
  });

  test("returns updated state after dispatch", () => {
    const store = makeStore();
    store.dispatch({ kind: "set_view", view: "sessions" });
    expect(store.getState().activeView).toBe("sessions");
  });

  test("getState is always fresh even before microtask fires", () => {
    const store = makeStore();
    store.dispatch({ kind: "set_view", view: "sessions" });
    // State is updated synchronously, even though notification is deferred
    expect(store.getState().activeView).toBe("sessions");
  });
});

// ---------------------------------------------------------------------------
// subscribe / unsubscribe
// ---------------------------------------------------------------------------

describe("TuiStore — subscribe", () => {
  test("subscribe returns unsubscribe function", () => {
    const store = makeStore();
    const unsub = store.subscribe(() => {});
    expect(typeof unsub).toBe("function");
  });

  test("subscriber fires after dispatch (on microtask)", async () => {
    const store = makeStore();
    const listener = mock(() => {});
    store.subscribe(listener);
    store.dispatch({ kind: "set_view", view: "sessions" });
    expect(listener).not.toHaveBeenCalled(); // not yet — microtask pending
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("unsubscribed listener does not fire", async () => {
    const store = makeStore();
    const listener = mock(() => {});
    const unsub = store.subscribe(listener);
    unsub();
    store.dispatch({ kind: "set_view", view: "sessions" });
    await flushMicrotasks();
    expect(listener).not.toHaveBeenCalled();
  });

  test("multiple subscribers all fire", async () => {
    const store = makeStore();
    const a = mock(() => {});
    const b = mock(() => {});
    store.subscribe(a);
    store.subscribe(b);
    store.dispatch({ kind: "set_view", view: "sessions" });
    await flushMicrotasks();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  test("selective unsubscribe — remaining listeners still fire", async () => {
    const store = makeStore();
    const a = mock(() => {});
    const b = mock(() => {});
    const unsubA = store.subscribe(a);
    store.subscribe(b);
    unsubA();
    store.dispatch({ kind: "set_view", view: "help" });
    await flushMicrotasks();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Microtask batching
// ---------------------------------------------------------------------------

describe("TuiStore — microtask batching", () => {
  test("multiple synchronous dispatches coalesce into one notification", async () => {
    const store = makeStore();
    const listener = mock(() => {});
    store.subscribe(listener);
    store.dispatch({ kind: "set_view", view: "sessions" });
    store.dispatch({ kind: "set_connection_status", status: "connected" });
    store.dispatch({ kind: "set_layout", tier: "wide" });
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(1);
    // State reflects all three dispatches
    const state = store.getState();
    expect(state.activeView).toBe("sessions");
    expect(state.connectionStatus).toBe("connected");
    expect(state.layoutTier).toBe("wide");
  });

  test("dispatches in separate microtask ticks fire separate notifications", async () => {
    const store = makeStore();
    const listener = mock(() => {});
    store.subscribe(listener);

    store.dispatch({ kind: "set_view", view: "sessions" });
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(1);

    store.dispatch({ kind: "set_view", view: "help" });
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// No-op guard
// ---------------------------------------------------------------------------

describe("TuiStore — no-op guard", () => {
  test("no-op dispatch still notifies external subscribers (SolidJS handles fine-grained no-op at signal level)", async () => {
    const store = makeStore();
    const listener = mock(() => {});
    store.subscribe(listener);
    // Dispatch same view — SolidJS store still runs produce(), external listeners notified
    // SolidJS reactive system handles the actual no-op at the signal level
    store.dispatch({ kind: "set_view", view: "conversation" });
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("mix of no-op and real dispatch notifies once (microtask coalesced)", async () => {
    const store = makeStore();
    const listener = mock(() => {});
    store.subscribe(listener);
    store.dispatch({ kind: "set_view", view: "conversation" }); // no-op (but still dispatches)
    store.dispatch({ kind: "set_view", view: "sessions" }); // real change
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Throwing listeners
// ---------------------------------------------------------------------------

describe("TuiStore — throwing listener", () => {
  test("throwing listener does not prevent other listeners from firing", async () => {
    const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
    const store = makeStore();
    const before = mock(() => {});
    const thrower = mock(() => {
      throw new Error("boom");
    });
    const after = mock(() => {});
    store.subscribe(before);
    store.subscribe(thrower);
    store.subscribe(after);
    store.dispatch({ kind: "set_view", view: "sessions" });
    await flushMicrotasks();
    expect(before).toHaveBeenCalledTimes(1);
    expect(thrower).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Dispatch during listener (re-entrancy)
// ---------------------------------------------------------------------------

describe("TuiStore — re-entrancy", () => {
  test("dispatch during listener does not cause infinite loop", async () => {
    const store = makeStore();
    let dispatchCount = 0;
    store.subscribe(() => {
      // Listener dispatches once (not infinite loop)
      if (dispatchCount === 0) {
        dispatchCount++;
        store.dispatch({ kind: "set_layout", tier: "compact" });
      }
    });
    store.dispatch({ kind: "set_view", view: "sessions" });
    await flushMicrotasks();
    // Second dispatch from listener should have been processed
    await flushMicrotasks();
    expect(store.getState().activeView).toBe("sessions");
    expect(store.getState().layoutTier).toBe("compact");
  });
});

// ---------------------------------------------------------------------------
// streamDelta — fast-path streaming text updates
// ---------------------------------------------------------------------------

/** Dispatch a turn_start to create a streaming assistant message. */
function startStreaming(store: ReturnType<typeof createStore>): void {
  const turnStart: EngineEvent = { kind: "turn_start", turnIndex: 0 };
  store.dispatch({ kind: "engine_event", event: turnStart });
}

describe("TuiStore — streamDelta", () => {
  test("appends text to existing text block via fast path", () => {
    const store = makeStore();
    startStreaming(store);
    // First delta creates the block (falls back to reconcile)
    store.streamDelta("Hello", "text");
    // Second delta uses fast path (produce)
    store.streamDelta(" world", "text");
    const messages = store.getState().messages;
    const last = messages[messages.length - 1];
    expect(last?.kind).toBe("assistant");
    if (last?.kind === "assistant") {
      expect(last.blocks.length).toBe(1);
      expect(last.blocks[0]?.kind).toBe("text");
      if (last.blocks[0]?.kind === "text") {
        expect(last.blocks[0].text).toBe("Hello world");
      }
    }
  });

  test("appends thinking delta to existing thinking block", () => {
    const store = makeStore();
    startStreaming(store);
    store.streamDelta("thinking...", "thinking");
    store.streamDelta(" more", "thinking");
    const messages = store.getState().messages;
    const last = messages[messages.length - 1];
    if (last?.kind === "assistant") {
      expect(last.blocks[0]?.kind).toBe("thinking");
      if (last.blocks[0]?.kind === "thinking") {
        expect(last.blocks[0].text).toBe("thinking... more");
      }
    }
  });

  test("empty delta is a no-op", () => {
    const store = makeStore();
    startStreaming(store);
    store.streamDelta("Hello", "text");
    store.streamDelta("", "text");
    const messages = store.getState().messages;
    const last = messages[messages.length - 1];
    if (last?.kind === "assistant") {
      expect(last.blocks.length).toBe(1);
      if (last.blocks[0]?.kind === "text") {
        expect(last.blocks[0].text).toBe("Hello");
      }
    }
  });

  test("falls back to reconcile when block kind changes (text after thinking)", () => {
    const store = makeStore();
    startStreaming(store);
    store.streamDelta("hmm", "thinking");
    // Text after thinking — creates a new block (structural change → reconcile fallback)
    store.streamDelta("answer", "text");
    const messages = store.getState().messages;
    const last = messages[messages.length - 1];
    if (last?.kind === "assistant") {
      expect(last.blocks.length).toBe(2);
      expect(last.blocks[0]?.kind).toBe("thinking");
      expect(last.blocks[1]?.kind).toBe("text");
    }
  });

  test("falls back to reconcile when no assistant message exists", () => {
    const store = makeStore();
    // No turn_start — streamDelta creates an implicit assistant message via reducer
    store.streamDelta("orphan", "text");
    const messages = store.getState().messages;
    const last = messages[messages.length - 1];
    expect(last?.kind).toBe("assistant");
    if (last?.kind === "assistant") {
      expect(last.blocks[0]?.kind).toBe("text");
      if (last.blocks[0]?.kind === "text") {
        expect(last.blocks[0].text).toBe("orphan");
      }
    }
  });

  test("snapshot stays consistent after fast-path deltas", () => {
    const store = makeStore();
    startStreaming(store);
    store.streamDelta("a", "text");
    store.streamDelta("b", "text");
    store.streamDelta("c", "text");
    // Now dispatch a non-delta event — reconcile should not overwrite the text
    const turnEnd: EngineEvent = { kind: "turn_end", turnIndex: 0 };
    store.dispatch({ kind: "engine_event", event: turnEnd });
    const messages = store.getState().messages;
    const last = messages[messages.length - 1];
    if (last?.kind === "assistant") {
      expect(last.streaming).toBe(false);
      if (last.blocks[0]?.kind === "text") {
        expect(last.blocks[0].text).toBe("abc");
      }
    }
  });

  test("notifies subscribers after streamDelta", async () => {
    const store = makeStore();
    const listener = mock(() => {});
    store.subscribe(listener);
    startStreaming(store);
    await flushMicrotasks();
    listener.mockClear();

    store.streamDelta("hi", "text");
    await flushMicrotasks();
    expect(listener).toHaveBeenCalled();
  });
});
