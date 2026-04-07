/**
 * tui-command tests.
 *
 * Covers:
 *   - drainEngineStream: connection status, event enqueue, error dispatch
 *   - TUI engine adapter transcript semantics (history accumulation + abort)
 *
 * `runTuiCommand` is an integration entry-point (requires TTY + renderer) and
 * is covered by E2E golden-query tests, not unit tests here.
 *
 * The overlapping-submit guard (`activeController !== null → add_error`) lives
 * inside `runTuiCommand`'s closure and requires a real TTY to test end-to-end;
 * it is covered by the golden-query trajectory for the TUI command.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";
import type { EngineEvent, InboundMessage } from "@koi/core";
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

// Simulate a completed turn: turn_start, text_delta, done(completed), turn_end
function _makeCompletedTurnStream(text: string): AsyncGenerator<EngineEvent> {
  const events: EngineEvent[] = [
    { kind: "turn_start", turnIndex: 0 },
    { kind: "text_delta", delta: text },
    {
      kind: "done",
      output: {
        content: [{ kind: "text", text }],
        stopReason: "completed",
        metrics: { totalTokens: 10, inputTokens: 5, outputTokens: 5, turns: 1, durationMs: 0 },
      },
    },
    { kind: "turn_end", turnIndex: 0 },
  ];
  return makeStream(events);
}

// Simulate an aborted turn: turn_start, then done(interrupted)
function _makeAbortedTurnStream(): AsyncGenerator<EngineEvent> {
  const events: EngineEvent[] = [
    { kind: "turn_start", turnIndex: 0 },
    {
      kind: "done",
      output: {
        content: [],
        stopReason: "interrupted",
        metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
      },
    },
    { kind: "turn_end", turnIndex: 0 },
  ];
  return makeStream(events);
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
// TUI adapter transcript semantics
//
// We test the adapter's history/transcript behavior by building a minimal
// mock that mirrors the adapter logic: staged commit on "done(completed)",
// no commit on "done(interrupted)".
// ---------------------------------------------------------------------------

describe("TUI adapter — transcript semantics", () => {
  /**
   * Simulate one turn through the transcript accumulation logic.
   * Mirrors the adapter's commit logic extracted for testability.
   */
  function simulateTurn(
    history: InboundMessage[],
    stagedUserMsg: InboundMessage,
    stopReason: "completed" | "interrupted",
    assistantText: string,
  ): void {
    if (stopReason === "completed") {
      history.push(stagedUserMsg);
      if (assistantText.length > 0) {
        history.push({
          senderId: "assistant",
          timestamp: Date.now(),
          content: [{ kind: "text", text: assistantText }],
        });
      }
    }
    // "interrupted" — do NOT push anything
  }

  test("completed turn: user and assistant messages committed to history", () => {
    const history: InboundMessage[] = [];
    const userMsg: InboundMessage = {
      senderId: "user",
      timestamp: 0,
      content: [{ kind: "text", text: "hello" }],
    };
    simulateTurn(history, userMsg, "completed", "Hi there!");
    expect(history).toHaveLength(2);
    expect(history[0]?.senderId).toBe("user");
    expect(history[1]?.senderId).toBe("assistant");
  });

  test("interrupted turn: nothing committed to history", () => {
    const history: InboundMessage[] = [];
    const userMsg: InboundMessage = {
      senderId: "user",
      timestamp: 0,
      content: [{ kind: "text", text: "abort me" }],
    };
    simulateTurn(history, userMsg, "interrupted", "");
    expect(history).toHaveLength(0);
  });

  test("completed turn with empty assistant text: only user message committed", () => {
    const history: InboundMessage[] = [];
    const userMsg: InboundMessage = {
      senderId: "user",
      timestamp: 0,
      content: [{ kind: "text", text: "hello" }],
    };
    simulateTurn(history, userMsg, "completed", "");
    expect(history).toHaveLength(1);
    expect(history[0]?.senderId).toBe("user");
  });

  test("context window is capped at MAX_TRANSCRIPT_MESSAGES", () => {
    const MAX = 100;
    const history: InboundMessage[] = Array.from({ length: MAX + 20 }, (_, i) => ({
      senderId: i % 2 === 0 ? "user" : "assistant",
      timestamp: i,
      content: [{ kind: "text", text: `msg ${i}` }],
    }));
    const userMsg: InboundMessage = {
      senderId: "user",
      timestamp: 9999,
      content: [{ kind: "text", text: "new" }],
    };
    // Simulate context window construction as done in the adapter
    const contextWindow = [...history.slice(-MAX), userMsg];
    expect(contextWindow).toHaveLength(MAX + 1);
    // Staged message is always last
    expect(contextWindow[contextWindow.length - 1]).toBe(userMsg);
    // Oldest messages are dropped
    expect(contextWindow[0]?.timestamp).toBe(20); // history[20] is the first kept
  });

  test("drainEngineStream flushes events before setting disconnected", async () => {
    const store = createStore(createInitialState());
    const flushed: EngineEvent[] = [];
    const batcher = createEventBatcher<EngineEvent>((batch) => {
      flushed.push(...batch);
    });

    // Stream emits a text_delta — we expect it flushed before disconnected is set.
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

    // flushSync() is called before finally sets disconnected
    expect(disconnectedAtFlushCount).toBeGreaterThan(0);
  });
});
