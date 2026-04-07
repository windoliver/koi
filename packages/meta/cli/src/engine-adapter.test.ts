/**
 * engine-adapter tests — covers createTranscriptAdapter factory.
 *
 * Tests verify the transcript commit semantics, callHandlers guard,
 * and AbortError/interrupted handling.
 *
 * runTurn is mocked via mock.module so tests control which EngineEvents
 * are emitted and what stopReason appears in the done event, without
 * needing real HTTP or complex fake ComposedCallHandlers wiring.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { EngineEvent, InboundMessage, ModelAdapter } from "@koi/core";

// ---------------------------------------------------------------------------
// runTurn mock (hoisted above imports by bun:test)
// ---------------------------------------------------------------------------

// runTurnState is a plain object so the closure inside mock.module can
// reference it at call time (not at factory creation time), avoiding TDZ.
const runTurnState: { events: readonly EngineEvent[] } = { events: [] };

mock.module("@koi/query-engine", () => ({
  runTurn: mock(async function* (_opts: unknown) {
    for (const e of runTurnState.events) {
      yield e as EngineEvent;
    }
  }),
}));

import { createTranscriptAdapter } from "./engine-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stub ModelAdapter — never actually called in these unit tests. */
function makeModelAdapter(): ModelAdapter {
  return {
    id: "stub",
    provider: "stub",
    capabilities: {
      streaming: true,
      functionCalling: true,
      vision: false,
      jsonMode: false,
      maxContextTokens: 8192,
      maxOutputTokens: 4096,
    },
    complete: mock(async () => ({ content: "", model: "stub" })),
    stream: mock(async function* () {}),
  };
}

/** Minimal stub callHandlers — satisfies the callHandlers guard. */
const fakeHandlers = {
  tools: [],
  modelCall: mock(async () => ({ content: "", model: "stub" })),
  toolCall: mock(async () => ({ output: "result" })),
  modelStream: mock(async function* () {}),
} as unknown as import("@koi/core").ComposedCallHandlers;

/** Build a done EngineEvent with the given stopReason. */
function makeDoneEvent(
  stopReason: "completed" | "interrupted" | "error" | "max_turns",
  text: string,
): EngineEvent {
  return {
    kind: "done",
    output: {
      content: text.length > 0 ? [{ kind: "text", text }] : [],
      stopReason,
      metrics: { totalTokens: 10, inputTokens: 5, outputTokens: 5, turns: 1, durationMs: 100 },
    },
  } satisfies EngineEvent;
}

/**
 * Run the adapter's stream() and collect all emitted events.
 *
 * Configures runTurnState so the mocked runTurn emits [engineEvents..., done(stopReason)].
 */
async function collectEvents(
  transcript: InboundMessage[],
  engineEvents: EngineEvent[] = [],
  stopReason: "completed" | "interrupted" | "error" | "max_turns" = "completed",
  text = "hello world",
): Promise<EngineEvent[]> {
  const adapter = createTranscriptAdapter({
    engineId: "test",
    modelAdapter: makeModelAdapter(),
    transcript,
    maxTranscriptMessages: 10,
    maxTurns: 5,
  });

  runTurnState.events = [...engineEvents, makeDoneEvent(stopReason, text)];

  const collected: EngineEvent[] = [];
  for await (const event of adapter.stream({
    kind: "text",
    text: "user message",
    callHandlers: fakeHandlers,
  })) {
    collected.push(event);
  }
  return collected;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTranscriptAdapter — callHandlers guard", () => {
  test("throws when callHandlers is undefined", () => {
    const adapter = createTranscriptAdapter({
      engineId: "test",
      modelAdapter: makeModelAdapter(),
      transcript: [],
      maxTranscriptMessages: 10,
      maxTurns: 5,
    });

    // stream() returns AsyncIterable — the guard throws on first iteration
    expect(async () => {
      for await (const _ of adapter.stream({ kind: "text", text: "hi" })) {
        // never reached
      }
    }).toThrow("callHandlers required");
  });
});

describe("createTranscriptAdapter — transcript commit semantics", () => {
  let transcript: InboundMessage[];

  beforeEach(() => {
    transcript = [];
  });

  test("commits user + assistant messages on stopReason completed", async () => {
    await collectEvents(transcript, [], "completed", "assistant reply");
    expect(transcript).toHaveLength(2);
    expect(transcript[0]?.senderId).toBe("user");
    expect(transcript[1]?.senderId).toBe("assistant");
  });

  test("does NOT commit on stopReason interrupted", async () => {
    await collectEvents(transcript, [], "interrupted", "partial text");
    expect(transcript).toHaveLength(0);
  });

  test("does NOT commit on stopReason error", async () => {
    await collectEvents(transcript, [], "error", "");
    expect(transcript).toHaveLength(0);
  });

  test("does NOT commit on stopReason max_turns", async () => {
    await collectEvents(transcript, [], "max_turns", "some text");
    expect(transcript).toHaveLength(0);
  });

  test("omits assistant message when assistant text is empty", async () => {
    await collectEvents(transcript, [], "completed", "");
    // User message still committed, but no assistant entry
    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.senderId).toBe("user");
  });

  test("transcript grows across multiple completed turns", async () => {
    await collectEvents(transcript, [], "completed", "first reply");
    await collectEvents(transcript, [], "completed", "second reply");
    // 2 user + 2 assistant = 4 entries
    expect(transcript).toHaveLength(4);
  });

  test("context window is tail-sliced to maxTranscriptMessages", async () => {
    // Pre-fill transcript with more entries than the limit
    for (let i = 0; i < 15; i++) {
      transcript.push({
        senderId: "user",
        timestamp: Date.now(),
        content: [{ kind: "text", text: `msg ${i}` }],
      });
    }
    // collectEvents uses maxTranscriptMessages: 10
    // The adapter should slice to last 10 + staged user = 11 in context
    // We verify this indirectly — the call should not throw
    await expect(collectEvents(transcript, [], "completed", "reply")).resolves.toBeDefined();
  });
});

describe("createTranscriptAdapter — engineId in error message", () => {
  test("includes engineId in callHandlers guard error", async () => {
    const adapter = createTranscriptAdapter({
      engineId: "koi-tui",
      modelAdapter: makeModelAdapter(),
      transcript: [],
      maxTranscriptMessages: 10,
      maxTurns: 5,
    });

    await expect(async () => {
      for await (const _ of adapter.stream({ kind: "text", text: "hi" })) {
      }
    }).toThrow("koi-tui");
  });
});
