import { describe, expect, mock, test } from "bun:test";
import type { ModelHandler, ModelRequest } from "@koi/core";
import { runReplLoop } from "./repl-loop.js";
import type { RlmEvent, RlmMiddlewareConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMinimalConfig(): RlmMiddlewareConfig {
  return {
    maxIterations: 10,
    maxInputBytes: 10_000,
    chunkSize: 100,
    contextWindowTokens: 10_000,
  };
}

/** Model that calls FINAL on first turn with a fixed answer. */
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

/** Model that returns no tool calls (implicit final). */
function createNoToolCallModel(text: string): ModelHandler {
  return mock(async () => ({
    content: text,
    model: "test",
  }));
}

/** Scripted model that returns different responses per turn. */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runReplLoop", () => {
  test("FINAL on first turn yields completed", async () => {
    const modelCall = createFinalOnFirstTurnModel("The answer is 42.");
    const result = await runReplLoop({
      modelCall,
      input: "What is 6 * 7?",
      question: "Calculate this.",
      config: createMinimalConfig(),
    });

    expect(result.stopReason).toBe("completed");
    expect(result.answer).toBe("The answer is 42.");
  });

  test("no tool calls treats response as implicit final answer", async () => {
    const modelCall = createNoToolCallModel("Direct answer without tools.");
    const result = await runReplLoop({
      modelCall,
      input: "quick question",
      question: "Answer this.",
      config: createMinimalConfig(),
    });

    expect(result.stopReason).toBe("completed");
    expect(result.answer).toBe("Direct answer without tools.");
  });

  test("maxIterations exceeded yields max_turns", async () => {
    const modelCall: ModelHandler = mock(async () => ({
      content: "examining...",
      model: "test",
      metadata: {
        toolCalls: [{ toolName: "input_info", callId: "c1", input: {} }],
      },
    }));

    const result = await runReplLoop({
      modelCall,
      input: "test input",
      question: "Analyze.",
      config: { ...createMinimalConfig(), maxIterations: 3 },
    });

    expect(result.stopReason).toBe("max_turns");
    expect(result.metrics.turns).toBe(3);
  });

  test("abort signal yields interrupted", async () => {
    const controller = new AbortController();
    controller.abort();

    const modelCall = createFinalOnFirstTurnModel("unused");
    const result = await runReplLoop({
      modelCall,
      input: "test",
      question: "Analyze.",
      config: createMinimalConfig(),
      signal: controller.signal,
    });

    expect(result.stopReason).toBe("interrupted");
  });

  test("oversized input yields error", async () => {
    const modelCall = createFinalOnFirstTurnModel("unused");
    const result = await runReplLoop({
      modelCall,
      input: "This input is way too long!",
      question: "Analyze.",
      config: { ...createMinimalConfig(), maxInputBytes: 10 },
    });

    expect(result.stopReason).toBe("error");
    expect(result.answer).toContain("exceeds maximum");
  });

  test("model error yields error stopReason", async () => {
    const modelCall: ModelHandler = mock(async () => {
      throw new Error("Model is down");
    });

    const result = await runReplLoop({
      modelCall,
      input: "test",
      question: "Analyze.",
      config: createMinimalConfig(),
    });

    expect(result.stopReason).toBe("error");
    expect(result.answer).toContain("Model is down");
  });

  test("emits events during execution", async () => {
    const events: RlmEvent[] = [];
    const modelCall = createFinalOnFirstTurnModel("The answer.");

    await runReplLoop({
      modelCall,
      input: "test input",
      question: "Analyze.",
      config: createMinimalConfig(),
      onEvent: (event) => events.push(event),
    });

    expect(events.some((e) => e.kind === "turn_start")).toBe(true);
    expect(events.some((e) => e.kind === "turn_end")).toBe(true);
    expect(events.some((e) => e.kind === "tool_dispatch")).toBe(true);
    expect(events.some((e) => e.kind === "done")).toBe(true);
  });

  test("full pipeline: input_info → examine → FINAL", async () => {
    const modelCall = createScriptedModel([
      {
        content: "Let me check the input.",
        toolCalls: [{ toolName: "input_info", callId: "c1", input: {} }],
      },
      {
        content: "Reading first bytes.",
        toolCalls: [{ toolName: "examine", callId: "c2", input: { offset: 0, length: 50 } }],
      },
      {
        content: "I have the answer.",
        toolCalls: [
          { toolName: "FINAL", callId: "c3", input: { answer: "Input is a JSON object." } },
        ],
      },
    ]);

    const result = await runReplLoop({
      modelCall,
      input: '{"key": "value"}',
      question: "What format is this?",
      config: createMinimalConfig(),
    });

    expect(result.stopReason).toBe("completed");
    expect(result.answer).toBe("Input is a JSON object.");
    expect(result.metrics.turns).toBe(3);
  });

  test("compaction triggered at threshold", async () => {
    const events: RlmEvent[] = [];
    const modelCall: ModelHandler = mock(async () => ({
      content: "x".repeat(200), // ~50 tokens per response
      model: "test",
      metadata: {
        toolCalls: [{ toolName: "input_info", callId: "c1", input: {} }],
      },
    }));

    await runReplLoop({
      modelCall,
      input: "test",
      question: "Analyze.",
      config: {
        ...createMinimalConfig(),
        contextWindowTokens: 100,
        compactionThreshold: 0.5,
        maxIterations: 5,
      },
      onEvent: (event) => events.push(event),
    });

    const compactionEvents = events.filter((e) => e.kind === "compaction");
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

    const result = await runReplLoop({
      modelCall,
      input: "test",
      question: "Analyze.",
      config: { ...createMinimalConfig(), spawnRlmChild, depth: 0 },
    });

    expect(result.stopReason).toBe("completed");
    expect(spawnRlmChild).toHaveBeenCalledTimes(1);
  });

  test("system context includes question and metadata", async () => {
    // let: capture first call
    let firstCallMessages: readonly unknown[] | undefined;

    const modelCall: ModelHandler = mock(async (req: ModelRequest) => {
      if (firstCallMessages === undefined) {
        firstCallMessages = req.messages;
      }
      return { content: "Quick answer.", model: "test" };
    });

    await runReplLoop({
      modelCall,
      input: '{"key": "value", "items": [1,2,3]}',
      question: "What is this?",
      config: createMinimalConfig(),
    });

    expect(firstCallMessages).toBeDefined();
    const firstMsg = firstCallMessages?.[0] as
      | { readonly content: readonly { readonly kind: string; readonly text?: string }[] }
      | undefined;
    const text = firstMsg?.content[0]?.kind === "text" ? (firstMsg.content[0].text ?? "") : "";

    expect(text).toContain("Format: json");
    expect(text).toContain("What is this?");
    expect(text).toContain("Chunks:");
  });
});
