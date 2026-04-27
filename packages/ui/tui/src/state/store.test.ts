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
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalIsTTY = process.stderr.isTTY;
    // Non-TTY context (CI/pipe) — stderr write is allowed.
    Object.defineProperty(process.stderr, "isTTY", { value: undefined, configurable: true });
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
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
    Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
  });

  test("throwing listener is silent on stderr when stderr is a TTY (active terminal)", async () => {
    // #1940: In TTY sessions the renderer controls the terminal; suppress raw stderr.
    // A second listener remains so the fatal-shutdown path is not taken.
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const store = makeStore();
    store.subscribe(() => {
      throw new Error("tty-boom");
    });
    store.subscribe(() => {});
    store.dispatch({ kind: "set_view", view: "sessions" });
    await flushMicrotasks();
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
    Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
  });

  test("throwing listener surfaces add_error block in TUI messages (TTY: visible, not silent)", async () => {
    // #1940: dispatch() notifies remaining subscribers so the renderer re-renders.
    // A second listener remains as the renderer stand-in so add_error has a target.
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: undefined, configurable: true });
    const store = makeStore();
    store.subscribe(() => {
      throw new Error("listener-boom");
    });
    store.subscribe(() => {});
    store.dispatch({ kind: "set_view", view: "sessions" });
    await flushMicrotasks(); // notifySubscribers: listener throws, queueMicrotask(dispatch)
    await flushMicrotasks(); // dispatch(add_error): state updated with error block
    const messages = store.getState().messages;
    const errorMsg = messages.find(
      (m) => m.kind === "assistant" && m.blocks.some((b) => b.kind === "error"),
    );
    expect(errorMsg).toBeDefined();
    if (errorMsg?.kind === "assistant") {
      const errorBlock = errorMsg.blocks.find((b) => b.kind === "error");
      if (errorBlock?.kind === "error") {
        expect(errorBlock.code).toBe("STORE_LISTENER_ERROR");
        expect(errorBlock.message).toContain("listener-boom");
      }
    }
    stderrSpy.mockRestore();
    Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
  });

  test("throwing listener is quarantined — subsequent dispatches do not re-invoke it", async () => {
    // #1940: listener is removed after first throw; no error-block flooding.
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: undefined, configurable: true });
    // Sole subscriber: provide onFatal so the fatal path doesn't terminate the test runner.
    const store = createStore(createInitialState(), { onFatal: () => {} });
    const thrower = mock(() => {
      throw new Error("once");
    });
    store.subscribe(thrower);
    store.dispatch({ kind: "set_view", view: "sessions" });
    await flushMicrotasks(); // listener invoked and quarantined
    await flushMicrotasks(); // fatal path
    expect(thrower).toHaveBeenCalledTimes(1); // only called once
    // Second dispatch must not re-invoke the quarantined listener.
    store.dispatch({ kind: "set_view", view: "help" });
    await flushMicrotasks();
    expect(thrower).toHaveBeenCalledTimes(1); // still only once
    stderrSpy.mockRestore();
    Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
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

// ---------------------------------------------------------------------------
// Listener failure / fatal-shutdown contract (#1940)
// ---------------------------------------------------------------------------

describe("TuiStore — listener failures", () => {
  test("quarantines a throwing listener and surfaces add_error to remaining subscribers", async () => {
    const stderrSpy = spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const store = createStore(createInitialState());
      const bad = mock(() => {
        throw new Error("boom");
      });
      const good = mock(() => {});
      store.subscribe(bad);
      store.subscribe(good);

      store.dispatch({ kind: "set_connection_status", status: "disconnected" });
      await flushMicrotasks();
      await flushMicrotasks();

      // The throwing listener was removed and the good listener still fires.
      expect(good).toHaveBeenCalled();
      // An error block was dispatched into the transcript.
      const lastMsg = store.getState().messages.at(-1);
      expect(lastMsg?.kind).toBe("assistant");
      if (lastMsg?.kind === "assistant") {
        expect(lastMsg.blocks.some((b) => b.kind === "error")).toBe(true);
      }
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("invokes onFatal when a critical subscriber throws (renderer-health contract)", async () => {
    const stderrSpy = spyOn(process.stderr, "write").mockReturnValue(true);
    const onFatal = mock((_e: Error) => {});
    try {
      const store = createStore(createInitialState(), { onFatal });
      const bad = mock(() => {
        throw new Error("renderer dead");
      });
      store.subscribe(bad, { critical: true });

      store.dispatch({ kind: "set_connection_status", status: "disconnected" });
      await flushMicrotasks();

      expect(onFatal).toHaveBeenCalledTimes(1);
      const arg = onFatal.mock.calls[0]?.[0];
      expect(arg).toBeInstanceOf(Error);
      expect((arg as Error).message).toBe("renderer dead");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("non-critical subscriber failure does NOT trigger fatal teardown", async () => {
    const stderrSpy = spyOn(process.stderr, "write").mockReturnValue(true);
    const onFatal = mock((_e: Error) => {});
    try {
      const store = createStore(createInitialState(), { onFatal });
      const bad = mock(() => {
        throw new Error("view-sync workaround failed");
      });
      // No `critical: true` — sole subscriber but renderer-health unaffected.
      store.subscribe(bad);

      store.dispatch({ kind: "set_connection_status", status: "disconnected" });
      await flushMicrotasks();

      expect(onFatal).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
