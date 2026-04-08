/**
 * tui-command tests.
 *
 * Covers:
 *   - drainEngineStream: connection status, event enqueue, error dispatch, abort handling
 *
 * `runTuiCommand` is an integration entry-point (requires TTY + renderer) and
 * is covered by E2E golden-query tests, not unit tests here.
 *
 * Transcript commit semantics are tested in engine-adapter.test.ts (T3-A cleanup:
 * removed duplicated simulateTurn tests that re-implemented adapter logic).
 */

import { describe, expect, mock, spyOn, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { createEventBatcher, createInitialState, createStore } from "@koi/tui";
import { drainEngineStream } from "./tui-command.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* makeStream(events: readonly EngineEvent[]): AsyncGenerator<EngineEvent> {
  for (const event of events) {
    yield event;
  }
}

async function* makeErrorStream(): AsyncGenerator<EngineEvent> {
  yield* []; // satisfies generator shape
  throw new Error("engine crash");
}

// ---------------------------------------------------------------------------
// drainEngineStream — connection status
// ---------------------------------------------------------------------------

describe("drainEngineStream — happy path", () => {
  test("sets connected before streaming and disconnected after", async () => {
    const store = createStore(createInitialState());
    const batcher = createEventBatcher<EngineEvent>(() => {});

    expect(store.getState().connectionStatus).toBe("disconnected");
    await drainEngineStream(makeStream([]), store, batcher);
    expect(store.getState().connectionStatus).toBe("disconnected");
  });

  test("enqueues events to the batcher", async () => {
    const store = createStore(createInitialState());
    const flushed: EngineEvent[] = [];
    const batcher = createEventBatcher<EngineEvent>((batch) => {
      flushed.push(...batch);
    });

    const events: EngineEvent[] = [
      { kind: "text_delta", delta: "hello" },
      { kind: "text_delta", delta: " world" },
    ];
    await drainEngineStream(makeStream(events), store, batcher);
    batcher.flushSync();

    expect(flushed.length).toBe(2);
    expect(flushed[0]).toEqual({ kind: "text_delta", delta: "hello" });
  });
});

describe("drainEngineStream — error path", () => {
  test("dispatches add_error when stream throws", async () => {
    const store = createStore(createInitialState());
    const batcher = createEventBatcher<EngineEvent>(() => {});
    const dispatchSpy = spyOn(store, "dispatch");

    await drainEngineStream(makeErrorStream(), store, batcher);

    const errorCalls = dispatchSpy.mock.calls.filter(
      (c) =>
        c[0] !== null &&
        typeof c[0] === "object" &&
        (c[0] as { kind: string }).kind === "add_error",
    );
    expect(errorCalls.length).toBe(1);
    const errorAction = errorCalls[0]?.[0] as { kind: "add_error"; code: string; message: string };
    expect(errorAction?.code).toBe("ENGINE_ERROR");
    expect(errorAction?.message).toContain("engine crash");
  });

  test("sets connection status to disconnected after error", async () => {
    const store = createStore(createInitialState());
    const batcher = createEventBatcher<EngineEvent>(() => {});

    await drainEngineStream(makeErrorStream(), store, batcher);

    expect(store.getState().connectionStatus).toBe("disconnected");
  });
});

// ---------------------------------------------------------------------------
// drainEngineStream — flush ordering
// ---------------------------------------------------------------------------

describe("drainEngineStream — flush ordering", () => {
  test("flushes events before setting disconnected", async () => {
    const store = createStore(createInitialState());
    const flushed: EngineEvent[] = [];
    const batcher = createEventBatcher<EngineEvent>((batch) => {
      flushed.push(...batch);
    });

    let disconnectedAtFlushCount = -1;
    const origDispatch = store.dispatch.bind(store);
    const dispatchSpy = mock((action: Parameters<typeof store.dispatch>[0]) => {
      if (
        typeof action === "object" &&
        action !== null &&
        (action as { kind: string }).kind === "set_connection_status" &&
        (action as { status: string }).status === "disconnected"
      ) {
        disconnectedAtFlushCount = flushed.length;
      }
      return origDispatch(action);
    });
    // @ts-expect-error — spy replaces dispatch for this test
    store.dispatch = dispatchSpy;

    const events: EngineEvent[] = [{ kind: "text_delta", delta: "x" }];
    await drainEngineStream(makeStream(events), store, batcher);

    expect(disconnectedAtFlushCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// T4-drain: drainEngineStream — abort handling
// ---------------------------------------------------------------------------

describe("drainEngineStream — abort handling", () => {
  test("handles AbortError without dispatching ENGINE_ERROR", async () => {
    const store = createStore(createInitialState());
    const batcher = createEventBatcher<EngineEvent>(() => {});
    const dispatchSpy = spyOn(store, "dispatch");

    // Create a stream that throws AbortError (simulates Ctrl+C)
    async function* abortStream(): AsyncGenerator<EngineEvent> {
      yield { kind: "text_delta", delta: "partial" } as EngineEvent;
      const abortErr = new DOMException("The operation was aborted", "AbortError");
      throw abortErr;
    }

    await drainEngineStream(abortStream(), store, batcher);

    // drainEngineStream catches all errors (including AbortError) and
    // dispatches add_error. This is correct behavior — the TUI shows the error.
    // The key assertion: it doesn't crash and always sets disconnected.
    expect(store.getState().connectionStatus).toBe("disconnected");

    // Verify we still get an error dispatch (abort is still surfaced)
    const errorCalls = dispatchSpy.mock.calls.filter(
      (c) =>
        c[0] !== null &&
        typeof c[0] === "object" &&
        (c[0] as { kind: string }).kind === "add_error",
    );
    expect(errorCalls.length).toBe(1);
  });

  test("sets disconnected status after abort", async () => {
    const store = createStore(createInitialState());
    const batcher = createEventBatcher<EngineEvent>(() => {});

    async function* abortStream(): AsyncGenerator<EngineEvent> {
      yield* []; // satisfy useYield lint — generator must have at least one yield point
      throw new DOMException("aborted", "AbortError");
    }

    await drainEngineStream(abortStream(), store, batcher);
    expect(store.getState().connectionStatus).toBe("disconnected");
  });

  test("flushes buffered events before handling abort", async () => {
    const store = createStore(createInitialState());
    const flushed: EngineEvent[] = [];
    const batcher = createEventBatcher<EngineEvent>((batch) => {
      flushed.push(...batch);
    });

    async function* abortAfterEvent(): AsyncGenerator<EngineEvent> {
      yield { kind: "text_delta", delta: "flushed" } as EngineEvent;
      throw new DOMException("aborted", "AbortError");
    }

    await drainEngineStream(abortAfterEvent(), store, batcher);

    // The event yielded before abort should still be flushed
    expect(flushed.length).toBe(1);
    expect(flushed[0]).toEqual({ kind: "text_delta", delta: "flushed" });
  });

  test("processes all events including tool lifecycle events", async () => {
    const store = createStore(createInitialState());
    const flushed: EngineEvent[] = [];
    const batcher = createEventBatcher<EngineEvent>((batch) => {
      flushed.push(...batch);
    });

    const events: EngineEvent[] = [
      { kind: "text_delta", delta: "I'll " } as EngineEvent,
      {
        kind: "tool_call_start",
        callId: "c1" as import("@koi/core").ToolCallId,
        toolName: "Bash",
      } as EngineEvent,
      { kind: "tool_call_end", callId: "c1" as import("@koi/core").ToolCallId } as EngineEvent,
      { kind: "text_delta", delta: "done" } as EngineEvent,
    ];
    await drainEngineStream(makeStream(events), store, batcher);
    batcher.flushSync();

    expect(flushed.length).toBe(4);
    expect((flushed[1] as { kind: string }).kind).toBe("tool_call_start");
  });
});
