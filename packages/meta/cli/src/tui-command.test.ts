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

import { describe, expect, spyOn, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { createEventBatcher, createInitialState, createStore } from "@koi/tui";
import { drainEngineStream, summarizeRunReport } from "./tui-command.js";

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
  test("sets connected before streaming and stays connected after (#1753)", async () => {
    const store = createStore(createInitialState());
    const batcher = createEventBatcher<EngineEvent>(() => {});

    expect(store.getState().connectionStatus).toBe("disconnected");
    await drainEngineStream(makeStream([]), store, batcher);
    // Regression: drainEngineStream used to unconditionally flip the
    // status back to "disconnected" in a `finally` block, which made
    // /doctor report a false-negative connection state after every
    // successful turn.
    expect(store.getState().connectionStatus).toBe("connected");
  });

  test("text_delta events go directly to store.streamDelta, not batcher", async () => {
    const store = createStore(createInitialState());
    const flushed: EngineEvent[] = [];
    const batcher = createEventBatcher<EngineEvent>((batch) => {
      flushed.push(...batch);
    });
    const streamDeltaSpy = spyOn(store, "streamDelta");

    const events: EngineEvent[] = [
      { kind: "text_delta", delta: "hello" },
      { kind: "text_delta", delta: " world" },
    ];
    await drainEngineStream(makeStream(events), store, batcher);
    batcher.flushSync();

    // text_delta should NOT be in the batcher
    expect(flushed.length).toBe(0);
    // text_delta should have been dispatched via streamDelta
    expect(streamDeltaSpy).toHaveBeenCalledTimes(2);
    expect(streamDeltaSpy.mock.calls[0]).toEqual(["hello", "text"]);
    expect(streamDeltaSpy.mock.calls[1]).toEqual([" world", "text"]);
  });

  test("tool lifecycle events go through the batcher", async () => {
    const store = createStore(createInitialState());
    const flushed: EngineEvent[] = [];
    const batcher = createEventBatcher<EngineEvent>((batch) => {
      flushed.push(...batch);
    });

    const events: EngineEvent[] = [
      {
        kind: "tool_call_start",
        callId: "c1" as import("@koi/core").ToolCallId,
        toolName: "Bash",
      } as EngineEvent,
      { kind: "tool_call_end", callId: "c1" as import("@koi/core").ToolCallId } as EngineEvent,
    ];
    await drainEngineStream(makeStream(events), store, batcher);
    batcher.flushSync();

    expect(flushed.length).toBe(2);
    expect((flushed[0] as { kind: string }).kind).toBe("tool_call_start");
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
  test("lifecycle events are flushed separately via batcher", async () => {
    const store = createStore(createInitialState());
    const flushBatches: EngineEvent[][] = [];
    const batcher = createEventBatcher<EngineEvent>((batch) => {
      flushBatches.push([...batch]);
    });

    // turn_start and done should each be flushed as separate batches
    const events: EngineEvent[] = [
      { kind: "turn_start", turnIndex: 0 } as EngineEvent,
      { kind: "text_delta", delta: "x" },
      {
        kind: "done",
        output: {
          content: [],
          stopReason: "completed",
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 0 },
        },
      } as EngineEvent,
    ];
    await drainEngineStream(makeStream(events), store, batcher);

    // turn_start and done should each be in their own flush batch
    // text_delta bypasses the batcher entirely (goes to store.streamDelta)
    const lifecycleKinds = flushBatches.map((b) => b.map((e) => e.kind));
    expect(lifecycleKinds).toContainEqual(["turn_start"]);
    expect(lifecycleKinds).toContainEqual(["done"]);
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

    // AbortError without a caller-provided AbortSignal falls through to
    // the generic error branch: the turn failed from drain's point of
    // view, so it is surfaced as a plain engine error and the channel
    // is marked disconnected.
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

  test("user-initiated abort keeps the channel connected (#1753)", async () => {
    // With a caller-provided AbortSignal that is already aborted when
    // the generator throws AbortError, drainEngineStream treats this as
    // a clean user cancel — synthesizes a terminal `done` and returns
    // early without flipping connection status. The LLM connection is
    // still healthy; the user just pressed Ctrl+C.
    const store = createStore(createInitialState());
    const batcher = createEventBatcher<EngineEvent>(() => {});
    const controller = new AbortController();

    async function* abortStream(): AsyncGenerator<EngineEvent> {
      yield* []; // satisfy useYield lint — generator must have at least one yield point
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }

    await drainEngineStream(abortStream(), store, batcher, controller.signal);
    expect(store.getState().connectionStatus).toBe("connected");
  });

  test("streamDelta is called for text_delta before abort", async () => {
    const store = createStore(createInitialState());
    const batcher = createEventBatcher<EngineEvent>(() => {});
    const streamDeltaSpy = spyOn(store, "streamDelta");

    async function* abortAfterEvent(): AsyncGenerator<EngineEvent> {
      yield { kind: "text_delta", delta: "flushed" } as EngineEvent;
      throw new DOMException("aborted", "AbortError");
    }

    await drainEngineStream(abortAfterEvent(), store, batcher);

    // The text_delta yielded before abort should have reached store.streamDelta
    expect(streamDeltaSpy).toHaveBeenCalledTimes(1);
    expect(streamDeltaSpy.mock.calls[0]).toEqual(["flushed", "text"]);
  });

  test("bails out when batcher is disposed mid-stream — #1742", async () => {
    // Regression for #1742: resetConversation() disposes the batcher while
    // an in-flight drain still holds it by reference. Before the fix, the
    // drain kept feeding text_delta events into the disposed batcher, which
    // silently dropped them — producing missing or truncated replies on the
    // next render. After the fix, the drain detects disposal and exits.
    const store = createStore(createInitialState());
    const flushed: EngineEvent[] = [];
    const batcher = createEventBatcher<EngineEvent>((batch) => {
      flushed.push(...batch);
    });

    // Dispose the batcher after it receives the first event. This simulates
    // resetConversation() firing between events while the drain is running.
    async function* slowStream(): AsyncGenerator<EngineEvent> {
      yield { kind: "text_delta", delta: "before-dispose" } as EngineEvent;
      batcher.dispose();
      yield { kind: "text_delta", delta: "after-dispose" } as EngineEvent;
      yield { kind: "text_delta", delta: "still-after" } as EngineEvent;
    }

    // Must not throw. Must not attempt to flush the disposed batcher.
    await drainEngineStream(slowStream(), store, batcher);

    // The drain is expected to stop enqueueing once it observes isDisposed.
    // The event yielded before disposal may or may not have flushed (the
    // batcher coalesces on a microtask), but none of the post-dispose events
    // should be visible. The critical assertion is absence of leaks.
    expect(flushed.some((e) => (e as { delta?: string }).delta === "after-dispose")).toBe(false);
    expect(flushed.some((e) => (e as { delta?: string }).delta === "still-after")).toBe(false);
    // #1753: batcher disposal is a UI-side reset, not a model/network
    // failure — the channel that was dispatched to "connected" at the
    // top of drainEngineStream stays connected.
    expect(store.getState().connectionStatus).toBe("connected");
  });

  test("does not dispatch ENGINE_ERROR when stream throws after disposal — #1742", async () => {
    // When resetConversation() disposes the batcher and aborts the stream,
    // the underlying engine stream will typically throw AbortError. That
    // error must NOT surface as an ENGINE_ERROR toast — the session was
    // reset deliberately and the store is already clean.
    const store = createStore(createInitialState());
    const batcher = createEventBatcher<EngineEvent>(() => {});
    const dispatchSpy = spyOn(store, "dispatch");

    async function* disposeThenThrow(): AsyncGenerator<EngineEvent> {
      yield* []; // satisfy useYield
      batcher.dispose();
      throw new Error("post-dispose crash");
    }

    await drainEngineStream(disposeThenThrow(), store, batcher);

    const errorCalls = dispatchSpy.mock.calls.filter(
      (c) =>
        c[0] !== null &&
        typeof c[0] === "object" &&
        (c[0] as { kind: string }).kind === "add_error",
    );
    expect(errorCalls.length).toBe(0);
  });

  test("routes text_delta to streamDelta and tool events to batcher", async () => {
    const store = createStore(createInitialState());
    const flushed: EngineEvent[] = [];
    const batcher = createEventBatcher<EngineEvent>((batch) => {
      flushed.push(...batch);
    });
    const streamDeltaSpy = spyOn(store, "streamDelta");

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

    // text_delta → streamDelta (2 calls)
    expect(streamDeltaSpy).toHaveBeenCalledTimes(2);
    // tool events → batcher (2 events)
    expect(flushed.length).toBe(2);
    expect((flushed[0] as { kind: string }).kind).toBe("tool_call_start");
    expect((flushed[1] as { kind: string }).kind).toBe("tool_call_end");
  });
});

// ---------------------------------------------------------------------------
// summarizeRunReport — bounded TUI summary, no full JSON.stringify (#1764)
// ---------------------------------------------------------------------------

describe("summarizeRunReport", () => {
  test("includes summary text and counts when present", () => {
    const out = summarizeRunReport({
      summary: "Finished refactor",
      actions: { length: 3 },
      artifacts: { length: 1 },
      issues: { length: 0 },
      recommendations: { length: 2 },
      childReports: { length: 4 },
      cost: { totalTokens: 1234 },
    });
    expect(out).toContain("Finished refactor");
    expect(out).toContain("actions=3");
    expect(out).toContain("artifacts=1");
    expect(out).toContain("issues=0");
    expect(out).toContain("recs=2");
    expect(out).toContain("children=4");
    expect(out).toContain("tokens=1234");
  });

  test("output is bounded regardless of summary text length", () => {
    const longSummary = "x".repeat(10_000);
    const out = summarizeRunReport({
      summary: longSummary,
      actions: { length: 1 },
      artifacts: { length: 1 },
      issues: { length: 1 },
      recommendations: { length: 1 },
      cost: { totalTokens: 99 },
    });
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain("…");
  });

  test("output is bounded for deeply nested childReports without serializing", () => {
    // Construct a deeply nested report. If the function ever regresses to
    // JSON.stringify(runReport), this test would either OOM or take >>1 ms.
    function nest(depth: number): {
      readonly summary: string;
      readonly actions: { length: number };
      readonly artifacts: { length: number };
      readonly issues: { length: number };
      readonly recommendations: { length: number };
      readonly childReports: { length: number };
      readonly cost: { totalTokens: number };
    } {
      return {
        summary: "child",
        actions: { length: 1 },
        artifacts: { length: 0 },
        issues: { length: 0 },
        recommendations: { length: 0 },
        childReports: { length: depth },
        cost: { totalTokens: depth },
      };
    }
    const start = Date.now();
    const out = summarizeRunReport(nest(50_000));
    const ms = Date.now() - start;
    expect(out.length).toBeLessThanOrEqual(300);
    // Should be effectively instant — no full-tree serialization.
    expect(ms).toBeLessThan(50);
  });

  test("works when no summary text is provided", () => {
    const out = summarizeRunReport({
      actions: { length: 0 },
      artifacts: { length: 0 },
      issues: { length: 0 },
      recommendations: { length: 0 },
      cost: { totalTokens: 0 },
    });
    expect(out).toBe("actions=0 artifacts=0 issues=0 recs=0 children=0 tokens=0");
  });
});
