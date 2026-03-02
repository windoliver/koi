import { describe, expect, mock, test } from "bun:test";
import type { EngineEvent, EngineOutput, ModelHandler } from "@koi/core";
import { createRlmAdapter } from "./adapter.js";
import type { RlmConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all events from an adapter stream. */
async function collectEvents(stream: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** Extract the done event output from an event stream. */
function findDoneEvent(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e) => e.kind === "done");
  return done?.kind === "done" ? done.output : undefined;
}

/** Create a model that returns FINAL tool call on first turn. */
function createFinalOnFirstTurnModel(answer: string): ModelHandler {
  return mock(async () => ({
    content: "I have the answer.",
    model: "test",
    metadata: {
      toolCalls: [
        {
          toolName: "FINAL",
          callId: "call-1",
          input: { answer },
        },
      ],
    },
  }));
}

/** Create a model that returns no tool calls (implicit final). */
function createNoToolCallModel(text: string): ModelHandler {
  return mock(async () => ({
    content: text,
    model: "test",
  }));
}

/** Create a scripted model that returns different responses per turn. */
function createScriptedModel(
  responses: ReadonlyArray<{
    readonly content: string;
    readonly toolCalls?: ReadonlyArray<{
      readonly toolName: string;
      readonly callId: string;
      readonly input: Record<string, unknown>;
    }>;
  }>,
): ModelHandler {
  // let: mutable turn counter for sequential responses
  let turn = 0;
  return mock(async () => {
    const r = responses[turn] ?? responses[responses.length - 1];
    turn++;
    if (r === undefined) {
      return { content: "fallback", model: "test" };
    }
    return {
      content: r.content,
      model: "test",
      ...(r.toolCalls !== undefined ? { metadata: { toolCalls: r.toolCalls } } : {}),
    };
  });
}

function createMinimalConfig(modelCall: ModelHandler): RlmConfig {
  return {
    modelCall,
    maxIterations: 10,
    maxInputBytes: 10_000,
    chunkSize: 100,
    contextWindowTokens: 10_000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRlmAdapter", () => {
  test("FINAL on first turn yields completed", async () => {
    const modelCall = createFinalOnFirstTurnModel("The answer is 42.");
    const adapter = createRlmAdapter(createMinimalConfig(modelCall));

    const events = await collectEvents(adapter.stream({ kind: "text", text: "What is 6 * 7?" }));
    const output = findDoneEvent(events);

    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
    expect(output?.content[0]?.kind).toBe("text");
    if (output?.content[0]?.kind === "text") {
      expect(output.content[0].text).toBe("The answer is 42.");
    }
  });

  test("no tool calls treats response as implicit final answer", async () => {
    const modelCall = createNoToolCallModel("Direct answer without tools.");
    const adapter = createRlmAdapter(createMinimalConfig(modelCall));

    const events = await collectEvents(adapter.stream({ kind: "text", text: "quick question" }));
    const output = findDoneEvent(events);

    expect(output?.stopReason).toBe("completed");
    if (output?.content[0]?.kind === "text") {
      expect(output.content[0].text).toBe("Direct answer without tools.");
    }
  });

  test("maxIterations exceeded yields max_turns", async () => {
    // Model always calls a tool but never FINAL
    const modelCall: ModelHandler = mock(async () => ({
      content: "examining...",
      model: "test",
      metadata: {
        toolCalls: [{ toolName: "input_info", callId: "c1", input: {} }],
      },
    }));

    const adapter = createRlmAdapter({
      ...createMinimalConfig(modelCall),
      maxIterations: 3,
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "test input" }));
    const output = findDoneEvent(events);

    expect(output?.stopReason).toBe("max_turns");
    expect(output?.metrics.turns).toBe(3);
  });

  test("dispose yields interrupted", async () => {
    // Model is slow enough for dispose to trigger
    const modelCall: ModelHandler = mock(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return {
        content: "slow response",
        model: "test",
        metadata: {
          toolCalls: [{ toolName: "input_info", callId: "c1", input: {} }],
        },
      };
    });

    const adapter = createRlmAdapter({
      ...createMinimalConfig(modelCall),
      maxIterations: 10,
    });

    // Start stream, dispose after first yield
    const events: EngineEvent[] = [];
    const streamIter = adapter.stream({ kind: "text", text: "test" });

    // Collect first few events then dispose
    for await (const event of streamIter) {
      events.push(event);
      if (event.kind === "turn_end") {
        await adapter.dispose?.();
      }
      if (event.kind === "done") break;
    }

    const output = findDoneEvent(events);
    expect(output?.stopReason).toBe("interrupted");
  });

  test("concurrent run guard throws", async () => {
    // Model is slow to keep first run alive
    const modelCall: ModelHandler = mock(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { content: "ok", model: "test" };
    });

    const adapter = createRlmAdapter(createMinimalConfig(modelCall));

    // Start first run (don't await)
    const stream1 = adapter.stream({ kind: "text", text: "run1" });
    // Manually get the first value to start the generator
    const iter = stream1[Symbol.asyncIterator]();
    const _first = iter.next(); // Starts the generator

    // Immediately try second run
    await expect(async () => {
      const stream2 = adapter.stream({ kind: "text", text: "run2" });
      for await (const _event of stream2) {
        // Should throw
      }
    }).toThrow(/concurrent runs/);

    // Clean up: drain first stream
    await adapter.dispose?.();
    try {
      await _first;
    } catch {
      // Expected — generator may error after dispose
    }
  });

  test("saveState/loadState round-trip", async () => {
    const modelCall = createFinalOnFirstTurnModel("answer");
    const adapter = createRlmAdapter(createMinimalConfig(modelCall));

    // Run to completion
    await collectEvents(adapter.stream({ kind: "text", text: "test" }));

    const state = await adapter.saveState?.();
    expect(state).toBeDefined();
    expect(state?.engineId).toBe("koi-rlm");

    // Create a new adapter and load state
    const adapter2 = createRlmAdapter(createMinimalConfig(modelCall));
    if (state !== undefined) {
      await adapter2.loadState?.(state);
    }

    const state2 = await adapter2.saveState?.();
    expect(state2?.engineId).toBe("koi-rlm");
  });

  test("loadState rejects wrong engine ID", async () => {
    const modelCall = createFinalOnFirstTurnModel("answer");
    const adapter = createRlmAdapter(createMinimalConfig(modelCall));

    await expect(adapter.loadState?.({ engineId: "wrong-engine", data: {} })).rejects.toThrow(
      /wrong-engine/,
    );
  });

  test("terminals exposed with modelCall", () => {
    const modelCall: ModelHandler = mock(async () => ({
      content: "test",
      model: "test",
    }));
    const adapter = createRlmAdapter(createMinimalConfig(modelCall));

    expect(adapter.terminals).toBeDefined();
    expect(adapter.terminals?.modelCall).toBe(modelCall);
  });

  test("oversized input yields done with error", async () => {
    const modelCall = createFinalOnFirstTurnModel("answer");
    const adapter = createRlmAdapter({
      ...createMinimalConfig(modelCall),
      maxInputBytes: 10,
    });

    const events = await collectEvents(
      adapter.stream({ kind: "text", text: "This input is way too long!" }),
    );
    const output = findDoneEvent(events);

    expect(output?.stopReason).toBe("error");
    if (output?.content[0]?.kind === "text") {
      expect(output.content[0].text).toContain("exceeds maximum");
    }
  });

  test("model error yields done with error stopReason", async () => {
    const modelCall: ModelHandler = mock(async () => {
      throw new Error("Model is down");
    });

    const adapter = createRlmAdapter(createMinimalConfig(modelCall));

    const events = await collectEvents(adapter.stream({ kind: "text", text: "test" }));
    const output = findDoneEvent(events);

    expect(output?.stopReason).toBe("error");
    if (output?.content[0]?.kind === "text") {
      expect(output.content[0].text).toContain("Model is down");
    }
  });

  test("compaction triggered at threshold", async () => {
    // Use a very small context window so compaction triggers quickly
    const modelCall: ModelHandler = mock(async () => ({
      content: "x".repeat(200), // 50 tokens per response
      model: "test",
      metadata: {
        toolCalls: [{ toolName: "input_info", callId: "c1", input: {} }],
      },
    }));

    const adapter = createRlmAdapter({
      ...createMinimalConfig(modelCall),
      contextWindowTokens: 100,
      compactionThreshold: 0.5,
      maxIterations: 5,
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "test" }));

    const compactionEvents = events.filter(
      (e) => e.kind === "custom" && (e as { readonly type: string }).type === "rlm:compaction",
    );
    expect(compactionEvents.length).toBeGreaterThan(0);
  });

  test("budget inheritance: rlm_query receives remaining budget", async () => {
    const spawnRlmChild = mock(
      async (req: { readonly remainingTokenBudget: number; readonly depth: number }) => {
        expect(req.depth).toBe(1);
        expect(req.remainingTokenBudget).toBeGreaterThan(0);
        return { answer: "child result", tokensUsed: 10 };
      },
    );

    const modelCall = createScriptedModel([
      {
        content: "Spawning child...",
        toolCalls: [{ toolName: "rlm_query", callId: "spawn-1", input: { input: "sub-task" } }],
      },
      {
        content: "Got child result.",
        toolCalls: [{ toolName: "FINAL", callId: "final-1", input: { answer: "done" } }],
      },
    ]);

    const adapter = createRlmAdapter({
      ...createMinimalConfig(modelCall),
      spawnRlmChild,
      depth: 0,
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "test" }));
    const output = findDoneEvent(events);

    expect(output?.stopReason).toBe("completed");
    expect(spawnRlmChild).toHaveBeenCalledTimes(1);
  });

  test("messages input kind extracts text", async () => {
    const modelCall = createFinalOnFirstTurnModel("answer from messages");
    const adapter = createRlmAdapter(createMinimalConfig(modelCall));

    const events = await collectEvents(
      adapter.stream({
        kind: "messages",
        messages: [
          {
            content: [{ kind: "text" as const, text: "Hello from messages" }],
            senderId: "user",
            timestamp: Date.now(),
          },
        ],
      }),
    );
    const output = findDoneEvent(events);
    expect(output?.stopReason).toBe("completed");
  });

  test("engineId is koi-rlm", () => {
    const modelCall: ModelHandler = mock(async () => ({
      content: "test",
      model: "test",
    }));
    const adapter = createRlmAdapter(createMinimalConfig(modelCall));
    expect(adapter.engineId).toBe("koi-rlm");
  });
});
