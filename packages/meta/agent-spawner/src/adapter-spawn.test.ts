import { describe, expect, test } from "bun:test";
import type { EngineAdapter, EngineCapabilities, EngineEvent, SpawnRequest } from "@koi/core";

import { createAdapterSpawnFn } from "./adapter-spawn.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_SIGNAL = AbortSignal.timeout(5_000);

const DEFAULT_CAPABILITIES: EngineCapabilities = {
  text: true,
  images: false,
  files: false,
  audio: false,
};

function createSpawnRequest(overrides?: Partial<SpawnRequest>): SpawnRequest {
  return {
    description: "do the thing",
    agentName: "test-agent",
    signal: DEFAULT_SIGNAL,
    ...overrides,
  };
}

function createMockAdapter(events: () => AsyncIterable<EngineEvent>): EngineAdapter {
  return {
    engineId: "mock-engine",
    capabilities: DEFAULT_CAPABILITIES,
    stream: () => events(),
  };
}

async function* generateEvents(items: readonly EngineEvent[]): AsyncIterable<EngineEvent> {
  for (const item of items) {
    yield item;
  }
}

function doneEvent(stopReason: "completed" | "max_turns" | "interrupted" | "error"): EngineEvent {
  return {
    kind: "done",
    output: {
      content: [],
      stopReason,
      metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
    },
  };
}

function textDelta(delta: string): EngineEvent {
  return { kind: "text_delta", delta };
}

// ---------------------------------------------------------------------------
// createAdapterSpawnFn
// ---------------------------------------------------------------------------

describe("createAdapterSpawnFn", () => {
  test("collects text deltas and returns concatenated output on completed", async () => {
    const adapter = createMockAdapter(() =>
      generateEvents([textDelta("a"), textDelta("b"), textDelta("c"), doneEvent("completed")]),
    );
    const spawn = createAdapterSpawnFn(adapter);
    const result = await spawn(createSpawnRequest());

    expect(result).toEqual({ ok: true, output: "abc" });
  });

  test("returns empty output when done fires with no text deltas", async () => {
    const adapter = createMockAdapter(() => generateEvents([doneEvent("completed")]));
    const spawn = createAdapterSpawnFn(adapter);
    const result = await spawn(createSpawnRequest());

    expect(result).toEqual({ ok: true, output: "" });
  });

  test("returns EXTERNAL error when adapter.stream() throws", async () => {
    const adapter = createMockAdapter(() => {
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return Promise.reject(new Error("kaboom"));
            },
          };
        },
      };
    });
    const spawn = createAdapterSpawnFn(adapter);
    const result = await spawn(createSpawnRequest());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("kaboom");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("returns TIMEOUT error when abort signal fires mid-stream", async () => {
    const controller = new AbortController();

    const adapter = createMockAdapter(() => {
      async function* abortMidStream(): AsyncIterable<EngineEvent> {
        yield textDelta("first");
        controller.abort();
        // Simulate the abort propagating as a DOMException
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return abortMidStream();
    });

    const spawn = createAdapterSpawnFn(adapter);
    const result = await spawn(createSpawnRequest({ signal: controller.signal }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.message).toBe("Spawn aborted by signal");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("returns non-retryable error for max_turns stop reason", async () => {
    const adapter = createMockAdapter(() =>
      generateEvents([textDelta("partial"), doneEvent("max_turns")]),
    );
    const spawn = createAdapterSpawnFn(adapter);
    const result = await spawn(createSpawnRequest());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("max_turns");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("returns retryable error for interrupted stop reason", async () => {
    const adapter = createMockAdapter(() => generateEvents([doneEvent("interrupted")]));
    const spawn = createAdapterSpawnFn(adapter);
    const result = await spawn(createSpawnRequest());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("interrupted");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("returns EXTERNAL error when stream ends without done event", async () => {
    const adapter = createMockAdapter(() => generateEvents([textDelta("a"), textDelta("b")]));
    const spawn = createAdapterSpawnFn(adapter);
    const result = await spawn(createSpawnRequest());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toBe("Engine stream ended without done event");
      expect(result.error.retryable).toBe(false);
    }
  });
});
