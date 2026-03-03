/**
 * Engine adapter contract test suite.
 *
 * Validates that any EngineAdapter implementation satisfies the L0 contract.
 * Usage: import { testEngineAdapter } from "@koi/test-utils" and call it
 * inside a describe() block with a factory function.
 */

import { expect, test } from "bun:test";
import type { EngineAdapter, EngineEvent, EngineInput, EngineOutput } from "@koi/core";

/** Collect all events from an async iterable. */
async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** Find the `done` event in a list of engine events. */
function findDone(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

export interface EngineContractOptions {
  /** Factory that creates a fresh adapter instance for each test. */
  readonly createAdapter: () => EngineAdapter | Promise<EngineAdapter>;
  /** Input to feed the adapter during tests. Defaults to a simple text input. */
  readonly input?: EngineInput;
  /** Timeout for each test in milliseconds. Defaults to 10_000. */
  readonly timeoutMs?: number;
}

/**
 * Runs the engine adapter contract test suite.
 *
 * Call this inside a `describe()` block. It will register tests that verify
 * the adapter satisfies all L0 contract invariants.
 */
export function testEngineAdapter(options: EngineContractOptions): void {
  const {
    createAdapter,
    input = { kind: "text" as const, text: "Hello" },
    timeoutMs = 10_000,
  } = options;

  test("engineId is a non-empty string", async () => {
    const adapter = await createAdapter();
    expect(typeof adapter.engineId).toBe("string");
    expect(adapter.engineId.length).toBeGreaterThan(0);
  });

  test("stream() returns an async iterable", async () => {
    const adapter = await createAdapter();
    const iterable = adapter.stream(input);
    expect(iterable[Symbol.asyncIterator]).toBeDefined();
    // Consume to prevent dangling iterators
    await collectEvents(iterable);
  });

  test(
    "stream yields at least one event",
    async () => {
      const adapter = await createAdapter();
      const events = await collectEvents(adapter.stream(input));
      expect(events.length).toBeGreaterThan(0);
    },
    timeoutMs,
  );

  test(
    "stream yields a done event as the last meaningful event",
    async () => {
      const adapter = await createAdapter();
      const events = await collectEvents(adapter.stream(input));
      const output = findDone(events);
      expect(output).toBeDefined();
    },
    timeoutMs,
  );

  test(
    "done event output has valid structure",
    async () => {
      const adapter = await createAdapter();
      const events = await collectEvents(adapter.stream(input));
      const output = findDone(events);
      expect(output).toBeDefined();
      if (output === undefined) return;

      // content is an array
      expect(Array.isArray(output.content)).toBe(true);

      // stopReason is a valid enum value
      expect(["completed", "max_turns", "interrupted", "error"]).toContain(output.stopReason);

      // metrics has required fields
      expect(typeof output.metrics.totalTokens).toBe("number");
      expect(typeof output.metrics.inputTokens).toBe("number");
      expect(typeof output.metrics.outputTokens).toBe("number");
      expect(typeof output.metrics.turns).toBe("number");
      expect(typeof output.metrics.durationMs).toBe("number");
      expect(output.metrics.durationMs).toBeGreaterThanOrEqual(0);
    },
    timeoutMs,
  );

  test(
    "text_delta events have non-empty delta",
    async () => {
      const adapter = await createAdapter();
      const events = await collectEvents(adapter.stream(input));
      const textDeltas = events.filter(
        (e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta",
      );
      for (const delta of textDeltas) {
        expect(typeof delta.delta).toBe("string");
        expect(delta.delta.length).toBeGreaterThan(0);
      }
    },
    timeoutMs,
  );

  test(
    "tool_call_start and tool_call_end events are paired by callId",
    async () => {
      const adapter = await createAdapter();
      const events = await collectEvents(adapter.stream(input));

      const starts = events.filter(
        (e): e is EngineEvent & { readonly kind: "tool_call_start" } =>
          e.kind === "tool_call_start",
      );
      const ends = events.filter(
        (e): e is EngineEvent & { readonly kind: "tool_call_end" } => e.kind === "tool_call_end",
      );

      const startIds = new Set(starts.map((s) => s.callId));
      const endIds = new Set(ends.map((e) => e.callId));

      // Every start must have a corresponding end
      for (const id of startIds) {
        expect(endIds.has(id)).toBe(true);
      }
      // Every end must have a corresponding start
      for (const id of endIds) {
        expect(startIds.has(id)).toBe(true);
      }
    },
    timeoutMs,
  );

  test(
    "tool_call_delta events have non-empty delta and valid callId",
    async () => {
      const adapter = await createAdapter();
      const events = await collectEvents(adapter.stream(input));

      const deltas = events.filter(
        (e): e is EngineEvent & { readonly kind: "tool_call_delta" } =>
          e.kind === "tool_call_delta",
      );
      for (const delta of deltas) {
        expect(typeof delta.callId).toBe("string");
        expect(delta.callId.length).toBeGreaterThan(0);
        expect(typeof delta.delta).toBe("string");
        expect(delta.delta.length).toBeGreaterThan(0);
      }
    },
    timeoutMs,
  );

  test(
    "tool_call_delta events reference a known tool_call_start callId",
    async () => {
      const adapter = await createAdapter();
      const events = await collectEvents(adapter.stream(input));

      const startIds = new Set(
        events
          .filter(
            (e): e is EngineEvent & { readonly kind: "tool_call_start" } =>
              e.kind === "tool_call_start",
          )
          .map((s) => s.callId),
      );

      const deltas = events.filter(
        (e): e is EngineEvent & { readonly kind: "tool_call_delta" } =>
          e.kind === "tool_call_delta",
      );

      for (const delta of deltas) {
        expect(startIds.has(delta.callId)).toBe(true);
      }
    },
    timeoutMs,
  );

  test(
    "all events have a valid kind",
    async () => {
      const adapter = await createAdapter();
      const events = await collectEvents(adapter.stream(input));
      const validKinds = new Set([
        "text_delta",
        "tool_call_start",
        "tool_call_delta",
        "tool_call_end",
        "turn_end",
        "done",
        "custom",
      ]);
      for (const event of events) {
        expect(validKinds.has(event.kind)).toBe(true);
      }
    },
    timeoutMs,
  );

  test("dispose() can be called without error", async () => {
    const adapter = await createAdapter();
    if (adapter.dispose) {
      await adapter.dispose();
    }
  });

  test("dispose() is idempotent", async () => {
    const adapter = await createAdapter();
    if (adapter.dispose) {
      await adapter.dispose();
      await adapter.dispose();
    }
  });

  test("stream is a function", async () => {
    const adapter = await createAdapter();
    expect(typeof adapter.stream).toBe("function");
  });

  test("capabilities is a valid EngineCapabilities object", async () => {
    const adapter = await createAdapter();
    expect(adapter.capabilities).toBeDefined();
    expect(typeof adapter.capabilities.text).toBe("boolean");
    expect(typeof adapter.capabilities.images).toBe("boolean");
    expect(typeof adapter.capabilities.files).toBe("boolean");
    expect(typeof adapter.capabilities.audio).toBe("boolean");
  });
}
