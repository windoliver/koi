import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { createTurnContext } from "./turn-context.js";
import type { OutputParser } from "./types.js";

/** Collect all events from the turn context queue. */
async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** Find the done event. */
function findDone(
  events: readonly EngineEvent[],
): Extract<EngineEvent, { readonly kind: "done" }> | undefined {
  return events.find(
    (e): e is Extract<EngineEvent, { readonly kind: "done" }> => e.kind === "done",
  );
}

/** Create a minimal no-op parser for testing. */
function createTestParser(): OutputParser {
  return {
    parseStdout(chunk: string) {
      return { events: [{ kind: "text_delta" as const, delta: chunk }] };
    },
    parseStderr(_chunk: string) {
      return [];
    },
    flush() {
      return [];
    },
  };
}

/** Create a parser that buffers and returns events on flush. */
function createBufferingParser(): OutputParser {
  const buffered: EngineEvent[] = [];
  return {
    parseStdout(_chunk: string) {
      return { events: [] };
    },
    parseStderr(_chunk: string) {
      return [];
    },
    flush() {
      buffered.push({ kind: "text_delta" as const, delta: "flushed" });
      return [...buffered];
    },
  };
}

describe("createTurnContext", () => {
  test("creates queue and is not finished initially", () => {
    const turn = createTurnContext({
      timeoutMs: 0,
      noOutputTimeoutMs: 0,
      parser: createTestParser(),
      startTime: Date.now(),
    });

    expect(turn.isFinished()).toBe(false);
    expect(turn.queue).toBeDefined();
    turn.cleanup();
  });

  test("finish emits done event and ends queue", async () => {
    const turn = createTurnContext({
      timeoutMs: 0,
      noOutputTimeoutMs: 0,
      parser: createTestParser(),
      startTime: Date.now(),
    });

    turn.finish("completed");
    expect(turn.isFinished()).toBe(true);

    const events = await collectEvents(turn.queue);
    const done = findDone(events);
    expect(done).toBeDefined();
    expect(done?.output.stopReason).toBe("completed");
    expect(done?.output.metrics.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("finish flushes parser before emitting done", async () => {
    const turn = createTurnContext({
      timeoutMs: 0,
      noOutputTimeoutMs: 0,
      parser: createBufferingParser(),
      startTime: Date.now(),
    });

    turn.finish("completed");

    const events = await collectEvents(turn.queue);
    // Flushed event should appear before done
    expect(events.length).toBe(2);
    expect(events[0]?.kind).toBe("text_delta");
    expect(events[1]?.kind).toBe("done");
  });

  test("double finish is no-op", async () => {
    const turn = createTurnContext({
      timeoutMs: 0,
      noOutputTimeoutMs: 0,
      parser: createTestParser(),
      startTime: Date.now(),
    });

    turn.finish("completed");
    turn.finish("error"); // second call should be ignored

    const events = await collectEvents(turn.queue);
    const doneEvents = events.filter((e) => e.kind === "done");
    expect(doneEvents.length).toBe(1);
    expect(findDone(events)?.output.stopReason).toBe("completed");
  });

  test("pre-aborted signal finishes immediately as interrupted", async () => {
    const controller = new AbortController();
    controller.abort();

    const turn = createTurnContext({
      timeoutMs: 0,
      noOutputTimeoutMs: 0,
      signal: controller.signal,
      parser: createTestParser(),
      startTime: Date.now(),
    });

    expect(turn.isFinished()).toBe(true);

    const events = await collectEvents(turn.queue);
    const done = findDone(events);
    expect(done?.output.stopReason).toBe("interrupted");
  });

  test("abort signal finishes as interrupted", async () => {
    const controller = new AbortController();
    const turn = createTurnContext({
      timeoutMs: 0,
      noOutputTimeoutMs: 0,
      signal: controller.signal,
      parser: createTestParser(),
      startTime: Date.now(),
    });

    expect(turn.isFinished()).toBe(false);
    controller.abort();

    const events = await collectEvents(turn.queue);
    const done = findDone(events);
    expect(done?.output.stopReason).toBe("interrupted");
  });

  test("timeout finishes as error", async () => {
    const turn = createTurnContext({
      timeoutMs: 100,
      noOutputTimeoutMs: 0,
      parser: createTestParser(),
      startTime: Date.now(),
    });

    const events = await collectEvents(turn.queue);
    const done = findDone(events);
    expect(done?.output.stopReason).toBe("error");
  }, 5_000);

  test("no-output watchdog finishes as error when no reset", async () => {
    const turn = createTurnContext({
      timeoutMs: 0,
      noOutputTimeoutMs: 100,
      parser: createTestParser(),
      startTime: Date.now(),
    });

    const events = await collectEvents(turn.queue);
    const done = findDone(events);
    expect(done?.output.stopReason).toBe("error");
  }, 5_000);

  test("resetWatchdog delays no-output timeout", async () => {
    const turn = createTurnContext({
      timeoutMs: 0,
      noOutputTimeoutMs: 150,
      parser: createTestParser(),
      startTime: Date.now(),
    });

    // Reset watchdog before it fires
    await new Promise((r) => setTimeout(r, 80));
    expect(turn.isFinished()).toBe(false);
    turn.resetWatchdog();

    await new Promise((r) => setTimeout(r, 80));
    expect(turn.isFinished()).toBe(false);

    // Now let it fire
    const events = await collectEvents(turn.queue);
    const done = findDone(events);
    expect(done?.output.stopReason).toBe("error");
  }, 5_000);

  test("cleanup clears timers without finishing", async () => {
    const turn = createTurnContext({
      timeoutMs: 100,
      noOutputTimeoutMs: 0,
      parser: createTestParser(),
      startTime: Date.now(),
    });

    turn.cleanup();

    // Wait past the timeout — should NOT have finished
    await new Promise((r) => setTimeout(r, 200));
    expect(turn.isFinished()).toBe(false);

    // Manually finish to clean up
    turn.finish("completed");
    await collectEvents(turn.queue);
  }, 5_000);

  test("onFinished callback is called with stop reason", async () => {
    // let: captured stop reason from callback
    let capturedReason: string | undefined;

    const turn = createTurnContext({
      timeoutMs: 0,
      noOutputTimeoutMs: 0,
      parser: createTestParser(),
      startTime: Date.now(),
      onFinished(reason) {
        capturedReason = reason;
      },
    });

    turn.finish("completed");
    await collectEvents(turn.queue);

    expect(capturedReason).toBe("completed");
  });

  test("pre-aborted signal does not start timeout timer", () => {
    const controller = new AbortController();
    controller.abort();

    const turn = createTurnContext({
      timeoutMs: 50,
      noOutputTimeoutMs: 0,
      signal: controller.signal,
      parser: createTestParser(),
      startTime: Date.now(),
    });

    // Already finished from abort — timeout should not have been set
    expect(turn.isFinished()).toBe(true);
    turn.cleanup();
  });
});
