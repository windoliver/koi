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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent } from "@koi/core";
import { COMMAND_DEFINITIONS, createEventBatcher, createInitialState, createStore } from "@koi/tui";
import {
  computeLiveMcpStatus,
  drainEngineStream,
  renderTranscriptMarkdown,
  summarizeRunReport,
} from "./tui-command.js";

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

describe("drainEngineStream — catch-time disposal race (#1753 review r6)", () => {
  test("batcher disposed between catch-time flush and synthetic done reports settled via UI-reset path", async () => {
    // Regression for round-6 finding: once the pre-abort
    // batcher.flushSync() succeeded, the old code blindly enqueued a
    // synthetic `done` and flushed it again. If something disposed
    // the batcher in that window (e.g. resetConversation() racing
    // the drain), enqueue+flush became no-ops, the terminal event
    // never reached the reducer, and the drain still returned
    // "settled" — producing bookkeeping against half-finalized state.
    //
    // After the fix, the catch branch re-checks batcher.isDisposed
    // and falls through to finalizeAbandonedStream so the caller
    // sees the same "UI reset" outcome as mid-stream disposal.
    const store = createStore(createInitialState());
    let flushCallCount = 0;
    const batcher = createEventBatcher<EngineEvent>(() => {
      flushCallCount += 1;
    });
    const controller = new AbortController();

    async function* s(): AsyncGenerator<EngineEvent> {
      yield { kind: "turn_start", turnIndex: 0 } as EngineEvent;
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }

    // Dispose the batcher as soon as the catch-time flushSync fires
    // its onFlush callback — simulating a resetConversation() that
    // ran during that microtask.
    const origFlush = batcher.flushSync.bind(batcher);
    batcher.flushSync = (): void => {
      origFlush();
      if (flushCallCount >= 1) batcher.dispose();
    };

    const outcome = await drainEngineStream(s(), store, batcher, controller.signal);

    // #1753 review round 7: the intentional UI reset is reported as
    // "abandoned" so the submit path skips cost/trajectory bookkeeping
    // that would otherwise overwrite the freshly reset session.
    expect(outcome).toBe("abandoned");
  });
});

describe("drainEngineStream — DrainOutcome contract (#1753 review r4)", () => {
  test("returns 'settled' on happy path", async () => {
    const store = createStore(createInitialState());
    const batcher = createEventBatcher<EngineEvent>(() => {});
    const outcome = await drainEngineStream(makeStream([]), store, batcher);
    expect(outcome).toBe("settled");
  });

  test("abandoned path publishes 'disconnected' so a reset-race failure cannot leave /doctor green (#1753 review r10)", async () => {
    // Regression for round-10 finding: the drain's entry dispatch of
    // `connected` used to persist across every abandoned exit. If
    // resetConversation() disposes the batcher AND then fails closed
    // without publishing a replacement connection state, /doctor
    // could report a healthy engine for a torn-down turn. The drain
    // now flips to `disconnected` on every abandoned branch so the
    // UI defaults to the safe state; the caller can re-assert
    // `connected` once the replacement session is ready.
    const store = createStore(createInitialState());
    const batcher = createEventBatcher<EngineEvent>(() => {});
    async function* s(): AsyncGenerator<EngineEvent> {
      yield { kind: "text_delta", delta: "x" } as EngineEvent;
      batcher.dispose();
      yield { kind: "text_delta", delta: "y" } as EngineEvent;
    }
    const outcome = await drainEngineStream(s(), store, batcher);
    expect(outcome).toBe("abandoned");
    expect(store.getState().connectionStatus).toBe("disconnected");
  });

  test("returns 'abandoned' when batcher is disposed mid-stream (#1753 review r7)", async () => {
    // Regression: UI resets (/clear, /new, session switch) dispose
    // the batcher mid-drain. Previously these returned "settled" and
    // the submit path ran cost/trajectory bookkeeping that republished
    // stale data into the freshly reset session.
    const store = createStore(createInitialState());
    const flushed: EngineEvent[] = [];
    const batcher = createEventBatcher<EngineEvent>((batch) => {
      flushed.push(...batch);
    });
    async function* s(): AsyncGenerator<EngineEvent> {
      yield { kind: "text_delta", delta: "before" } as EngineEvent;
      batcher.dispose();
      yield { kind: "text_delta", delta: "after" } as EngineEvent;
    }
    const outcome = await drainEngineStream(s(), store, batcher);
    expect(outcome).toBe("abandoned");
  });

  test("returns 'settled' on user abort with clean finalization", async () => {
    const store = createStore(createInitialState());
    const batcher = createEventBatcher<EngineEvent>(() => {});
    const controller = new AbortController();
    async function* s(): AsyncGenerator<EngineEvent> {
      yield* [];
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }
    const outcome = await drainEngineStream(s(), store, batcher, controller.signal);
    expect(outcome).toBe("settled");
  });

  test("returns 'engine_error' on a real ENGINE_ERROR so refresh runs but rewind does not advance (#1753 review r5+r9)", async () => {
    // Regression:
    // - r5: rounds 4 initially marked real engine errors as "failed",
    //   which caused the TUI submit path to skip the only post-turn
    //   refreshTrajectoryData() call. Clean ENGINE_ERRORs must keep
    //   their observability refresh.
    // - r9: rounds 5 over-corrected and used plain "settled", which
    //   caused the submit path to increment `postClearTurnCount` for
    //   failed turns even though no rewindable checkpoint was
    //   produced, allowing `/rewind` to step across a clear boundary.
    // The fix splits the outcomes: ENGINE_ERROR is "engine_error",
    // which the submit path treats as refresh-safe but
    // rewind-unsafe.
    const store = createStore(createInitialState());
    const batcher = createEventBatcher<EngineEvent>(() => {});
    const outcome = await drainEngineStream(makeErrorStream(), store, batcher);
    expect(outcome).toBe("engine_error");
    // And the error was still surfaced + connection marked disconnected.
    expect(store.getState().connectionStatus).toBe("disconnected");
  });

  test("returns 'failed' when a catch-time flush drops buffered events", async () => {
    const store = createStore(createInitialState());
    let callCount = 0;
    const batcher = createEventBatcher<EngineEvent>(() => {
      callCount += 1;
      if (callCount === 1) throw new Error("boom");
    });
    const controller = new AbortController();
    async function* s(): AsyncGenerator<EngineEvent> {
      yield {
        kind: "tool_call_start",
        callId: "c1" as import("@koi/core").ToolCallId,
        toolName: "Bash",
      } as EngineEvent;
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }
    const outcome = await drainEngineStream(s(), store, batcher, controller.signal);
    expect(outcome).toBe("failed");
  });
});

describe("drainEngineStream — fail-closed when pre-abort flush drops buffered events (#1753 review r3)", () => {
  test("abort-looking error with a first-flush that throws fails closed instead of reporting clean abort", async () => {
    // Regression for round-3 review finding: EventBatcher.flushSync()
    // clears its buffer before invoking onFlush, so if the reducer
    // crashes during the pre-abort flush the buffered events are lost
    // permanently. Previously drainEngineStream swallowed that throw
    // and continued into the clean-abort branch, leaving the channel
    // "connected" and surfacing no error.
    const store = createStore(createInitialState());
    // First flush throws (simulates reducer crash on a buffered
    // tool_call_start); subsequent flushes succeed so the synthetic
    // abort `done` path would otherwise run cleanly.
    // let: flips after the first throw to exercise the drop-then-
    // continue scenario the review reproduced.
    let callCount = 0;
    const batcher = createEventBatcher<EngineEvent>(() => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("reducer exploded on buffered tool_call_start");
      }
    });
    const controller = new AbortController();

    async function* abortStream(): AsyncGenerator<EngineEvent> {
      yield {
        kind: "tool_call_start",
        callId: "c1" as import("@koi/core").ToolCallId,
        toolName: "Bash",
      } as EngineEvent;
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }

    const dispatchSpy = spyOn(store, "dispatch");
    await drainEngineStream(abortStream(), store, batcher, controller.signal);

    expect(store.getState().connectionStatus).toBe("disconnected");
    const errorCalls = dispatchSpy.mock.calls.filter(
      (c) =>
        c[0] !== null &&
        typeof c[0] === "object" &&
        (c[0] as { kind: string }).kind === "add_error",
    );
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    expect((errorCalls[0]?.[0] as { code: string }).code).toBe("ENGINE_ERROR");
  });
});

describe("drainEngineStream — fail-closed on abort-path flush throw (#1753 review r2)", () => {
  test("user abort with a throwing reducer still marks disconnected and surfaces ENGINE_ERROR", async () => {
    // Regression for round-2 review finding: previously the abort
    // branch swallowed flush failures from the synthetic `done` flush
    // and still marked the turn as terminally handled, so a crashing
    // reducer during abort finalization left /doctor reporting
    // "connected" with no error visible.
    const store = createStore(createInitialState());
    // let: toggled to "poisoned" right before the synthetic done flush
    // so earlier pre-catch flushes (happy-path lifecycle / swallowed
    // inner catch flush) do not short-circuit the abort branch.
    let poisoned = false;
    const batcher = createEventBatcher<EngineEvent>(() => {
      if (poisoned) throw new Error("reducer exploded during abort");
    });
    const controller = new AbortController();

    async function* abortStream(): AsyncGenerator<EngineEvent> {
      yield* []; // satisfy useYield
      controller.abort();
      poisoned = true;
      throw new DOMException("aborted", "AbortError");
    }

    const dispatchSpy = spyOn(store, "dispatch");
    await drainEngineStream(abortStream(), store, batcher, controller.signal);

    expect(store.getState().connectionStatus).toBe("disconnected");
    const errorCalls = dispatchSpy.mock.calls.filter(
      (c) =>
        c[0] !== null &&
        typeof c[0] === "object" &&
        (c[0] as { kind: string }).kind === "add_error",
    );
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    expect((errorCalls[0]?.[0] as { code: string }).code).toBe("ENGINE_ERROR");
  });
});

describe("drainEngineStream — fail-closed on flush throw (#1753 review)", () => {
  test("thrown flush during stream completion still marks disconnected and surfaces ENGINE_ERROR", async () => {
    // Regression for review finding: previously a `finally` block
    // always marked the channel disconnected. Removing it to fix
    // #1753 must not open a hole where a throwing flush (buffered
    // reducer callback crashes) silently leaves /doctor "connected"
    // with no error surfaced. The catch branch must fail closed.
    const store = createStore(createInitialState());
    const throwOnFlush = createEventBatcher<EngineEvent>(() => {
      throw new Error("reducer exploded during flush");
    });
    const dispatchSpy = spyOn(store, "dispatch");

    // Lifecycle events go through batcher.flushSync() — the throw
    // from onFlush will bubble out of the try block into the catch.
    const events: EngineEvent[] = [
      { kind: "turn_start", turnIndex: 0 } as EngineEvent,
      {
        kind: "done",
        output: {
          content: [],
          stopReason: "completed",
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 0 },
        },
      } as EngineEvent,
    ];

    await drainEngineStream(makeStream(events), store, throwOnFlush);

    expect(store.getState().connectionStatus).toBe("disconnected");
    const errorCalls = dispatchSpy.mock.calls.filter(
      (c) =>
        c[0] !== null &&
        typeof c[0] === "object" &&
        (c[0] as { kind: string }).kind === "add_error",
    );
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    expect((errorCalls[0]?.[0] as { code: string }).code).toBe("ENGINE_ERROR");
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
    // #1753 review round 10: batcher disposal takes the drain's
    // abandoned branch, which flips the connection to disconnected
    // so a subsequent failed resetConversation() cannot leave
    // /doctor reporting a healthy engine for a torn-down turn.
    // The replacement session is responsible for re-asserting
    // "connected" on its first successful turn.
    expect(store.getState().connectionStatus).toBe("disconnected");
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

// ---------------------------------------------------------------------------
// renderTranscriptMarkdown — /export output format (#1752)
// ---------------------------------------------------------------------------

describe("renderTranscriptMarkdown", () => {
  test("renders header + user/assistant sections", () => {
    const md = renderTranscriptMarkdown(
      [
        { role: "user", content: [{ kind: "text", text: "hello" }] },
        { role: "assistant", content: [{ kind: "text", text: "hi there" }] },
      ],
      { sessionId: "sess-123", modelName: "anthropic/claude-sonnet-4-6", provider: "openrouter" },
    );
    expect(md).toContain("# Koi Session sess-123");
    expect(md).toContain("**Model**: anthropic/claude-sonnet-4-6");
    expect(md).toContain("**Provider**: openrouter");
    expect(md).toContain("## User");
    expect(md).toContain("hello");
    expect(md).toContain("## Assistant");
    expect(md).toContain("hi there");
  });

  test("renders non-text blocks as placeholders", () => {
    const md = renderTranscriptMarkdown(
      [
        {
          role: "user",
          content: [
            { kind: "text", text: "see this" },
            { kind: "image", url: "https://example.com/x.png" },
          ],
        },
      ],
      { sessionId: "s", modelName: "m", provider: "p" },
    );
    expect(md).toContain("see this");
    expect(md).toContain("_[image block]_");
  });

  test("produces a valid document for an empty transcript", () => {
    const md = renderTranscriptMarkdown([], {
      sessionId: "empty",
      modelName: "m",
      provider: "p",
    });
    expect(md).toContain("# Koi Session empty");
    // No user/assistant sections.
    expect(md).not.toContain("## User");
    expect(md).not.toContain("## Assistant");
  });
});

// ---------------------------------------------------------------------------
// Regression: issue #1752 — every advertised slash command is handled
// ---------------------------------------------------------------------------

describe("onCommand dispatch coverage — #1752", () => {
  // Commands advertised in the palette that reach the host's onCommand
  // callback (as opposed to nav:* and a handful of session:* / display:*
  // commands that TuiRoot handles internally and never bubbles up). Issue
  // #1752 reported that every id listed here fell through to the `default:`
  // branch and returned COMMAND_NOT_IMPLEMENTED. Locked in below.
  const HOST_DISPATCHED_COMMAND_IDS = [
    "agent:interrupt",
    "agent:clear",
    "agent:compact",
    "agent:rewind",
    "session:new",
    "session:export",
    "system:model",
    "system:cost",
    "system:tokens",
    "system:zoom",
    "system:quit",
  ] as const;

  test("every host-dispatched command id is defined in COMMAND_DEFINITIONS", () => {
    const defined = new Set(COMMAND_DEFINITIONS.map((c) => c.id));
    for (const id of HOST_DISPATCHED_COMMAND_IDS) {
      expect(defined.has(id)).toBe(true);
    }
  });

  test("every host-dispatched command id has a case clause in tui-command.ts", () => {
    const src = readFileSync(join(import.meta.dir, "tui-command.ts"), "utf8");
    const missing: string[] = [];
    for (const id of HOST_DISPATCHED_COMMAND_IDS) {
      if (!src.includes(`case "${id}"`)) {
        missing.push(id);
      }
    }
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeLiveMcpStatus — #1852 regression: stdio servers must never be
// labeled `needs-auth` when the resolver returns `AUTH_REQUIRED` from a
// pattern-matched stderr string.
// ---------------------------------------------------------------------------

describe("computeLiveMcpStatus", () => {
  test("undefined failureCode → connected regardless of transport/oauth", () => {
    expect(computeLiveMcpStatus(undefined, "stdio", false)).toBe("connected");
    expect(computeLiveMcpStatus(undefined, "http", true)).toBe("connected");
    expect(computeLiveMcpStatus(undefined, "sse", false)).toBe("connected");
    expect(computeLiveMcpStatus(undefined, undefined, false)).toBe("connected");
  });

  test("AUTH_REQUIRED on stdio → error (#1852)", () => {
    // Regression: pattern-matched 'unauthorized' on stdio stderr previously
    // surfaced as needs-auth, an impossible state for a transport without
    // an OAuth flow.
    expect(computeLiveMcpStatus("AUTH_REQUIRED", "stdio", false)).toBe("error");
  });

  test("AUTH_REQUIRED on sse → error (no OAuth flow)", () => {
    expect(computeLiveMcpStatus("AUTH_REQUIRED", "sse", false)).toBe("error");
  });

  test("AUTH_REQUIRED on http with OAuth → needs-auth (Enter triggers OAuth)", () => {
    expect(computeLiveMcpStatus("AUTH_REQUIRED", "http", true)).toBe("needs-auth");
  });

  test("AUTH_REQUIRED on http without OAuth → error (no usable auth flow)", () => {
    // Static-token / API-key / basic-auth HTTP servers can't be fixed via TUI OAuth.
    // Also covers plugin-backed HTTP servers: getMcpStatus() forces hasOAuth=false for
    // all plugin entries because nav:mcp-auth rejects plugin: prefixed names (#1852).
    expect(computeLiveMcpStatus("AUTH_REQUIRED", "http", false)).toBe("error");
  });

  test("AUTH_REQUIRED with unknown transport → error (conservative default)", () => {
    // Transport is now always available from config; undefined is only reachable
    // for truly unknown servers. Fail closed: don't surface an Enter-to-auth
    // prompt when we can't confirm auth capability.
    expect(computeLiveMcpStatus("AUTH_REQUIRED", undefined, false)).toBe("error");
  });

  test("non-auth failure code → error for any transport", () => {
    expect(computeLiveMcpStatus("CONNECT_TIMEOUT", "stdio", false)).toBe("error");
    expect(computeLiveMcpStatus("CONNECT_TIMEOUT", "http", true)).toBe("error");
    expect(computeLiveMcpStatus("INTERNAL", undefined, false)).toBe("error");
  });
});
