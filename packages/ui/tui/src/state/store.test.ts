import { describe, expect, mock, spyOn, test } from "bun:test";
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
