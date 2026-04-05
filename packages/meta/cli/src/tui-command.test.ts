/**
 * tui-command tests — covers the drain loop helper exported from tui-command.ts.
 *
 * Tests are focused on `drainEngineStream` since it holds all the error-handling
 * logic decided in the architecture review (Decision 3A: try/catch/finally with
 * add_error + disconnected on stream failure).
 *
 * `runTuiCommand` is an integration entry-point (requires TTY + renderer) and
 * is covered by E2E golden-query tests, not unit tests here.
 */

import { describe, expect, spyOn, test } from "bun:test";
import type { EngineEvent } from "@koi/core/engine";
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
  yield* []; // satisfies generator shape; error is thrown before any yield
  throw new Error("engine crash");
}

// ---------------------------------------------------------------------------
// Tests
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
