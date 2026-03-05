/**
 * Tests for the code-execution REPL loop.
 */

import { describe, expect, mock, test } from "bun:test";
import type { ModelHandler, ModelResponse } from "@koi/core";
import { runCodeReplLoop } from "./code-repl-loop.js";
import type { RlmMiddlewareConfig, RlmScriptResult, RlmScriptRunner } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockModelCall(responses: readonly string[]): ModelHandler {
  // Justified `let`: counter incremented per call
  let callIdx = 0;
  return mock(async (): Promise<ModelResponse> => {
    const content = responses[callIdx] ?? "No more responses";
    callIdx++;
    return { content, model: "test-model", usage: { inputTokens: 10, outputTokens: 5 } };
  }) as unknown as ModelHandler;
}

function createMockScriptRunner(results: readonly RlmScriptResult[]): {
  readonly runner: RlmScriptRunner;
  readonly calls: Array<{ readonly code: string }>;
} {
  const calls: Array<{ readonly code: string }> = [];
  // Justified `let`: counter incremented per call
  let callIdx = 0;
  const runner: RlmScriptRunner = {
    run: mock(async (config) => {
      calls.push({ code: config.code });
      const result = results[callIdx] ?? { ok: true, console: [], result: undefined, callCount: 0 };
      callIdx++;
      return result;
    }),
  };
  return { runner, calls };
}

const BASE_CONFIG: RlmMiddlewareConfig = {
  maxIterations: 10,
  contextWindowTokens: 100_000,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runCodeReplLoop", () => {
  test("returns answer when SUBMIT is called via host function", async () => {
    const modelCall = createMockModelCall(['```javascript\nSUBMIT("the answer is 42");\n```']);

    // Simulate SUBMIT being called by intercepting host functions
    const realRunner: RlmScriptRunner = {
      run: async (config) => {
        // Find and call the SUBMIT host function
        const submitFn = config.hostFns.get("SUBMIT");
        if (submitFn !== undefined) {
          await submitFn({ answer: "the answer is 42" });
        }
        return { ok: true, console: ["running..."], result: undefined, callCount: 1 };
      },
    };

    const result = await runCodeReplLoop({
      scriptRunner: realRunner,
      modelCall,
      input: "test input data",
      question: "What is the answer?",
      config: BASE_CONFIG,
    });

    expect(result.stopReason).toBe("completed");
    expect(result.answer).toBe("the answer is 42");
  });

  test("returns implicit final when model produces no code block", async () => {
    const modelCall = createMockModelCall(["I analyzed the data and found nothing special."]);
    const { runner } = createMockScriptRunner([]);

    const result = await runCodeReplLoop({
      scriptRunner: runner,
      modelCall,
      input: "some data",
      question: "What do you see?",
      config: BASE_CONFIG,
    });

    expect(result.stopReason).toBe("completed");
    expect(result.answer).toBe("I analyzed the data and found nothing special.");
    expect(result.metrics.turns).toBe(1);
  });

  test("returns error when input exceeds max bytes", async () => {
    const modelCall = createMockModelCall([]);
    const { runner } = createMockScriptRunner([]);

    const result = await runCodeReplLoop({
      scriptRunner: runner,
      modelCall,
      input: "x".repeat(1000),
      question: "q",
      config: { ...BASE_CONFIG, maxInputBytes: 100 },
    });

    expect(result.stopReason).toBe("error");
    expect(result.answer).toContain("exceeds maximum");
  });

  test("returns error on model call failure", async () => {
    const modelCall = mock(async () => {
      throw new Error("API unavailable");
    }) as unknown as ModelHandler;
    const { runner } = createMockScriptRunner([]);

    const result = await runCodeReplLoop({
      scriptRunner: runner,
      modelCall,
      input: "test",
      question: "q",
      config: BASE_CONFIG,
    });

    expect(result.stopReason).toBe("error");
    expect(result.answer).toContain("API unavailable");
  });

  test("handles script execution error and continues", async () => {
    const modelCall = createMockModelCall([
      '```javascript\nthrow new Error("bad code");\n```',
      "After error, the answer is 7.",
    ]);

    const { runner } = createMockScriptRunner([
      { ok: false, console: [], result: undefined, error: "bad code", callCount: 0 },
    ]);

    const result = await runCodeReplLoop({
      scriptRunner: runner,
      modelCall,
      input: "data here",
      question: "q",
      config: BASE_CONFIG,
    });

    // Second model response has no code block → implicit final
    expect(result.stopReason).toBe("completed");
    expect(result.answer).toBe("After error, the answer is 7.");
    expect(result.metrics.turns).toBe(2);
  });

  test("stops at maxIterations", async () => {
    // Model always returns code but SUBMIT is never called
    const responses = Array.from({ length: 5 }, () => '```javascript\nconsole.log("hi");\n```');
    const modelCall = createMockModelCall(responses);
    const scriptResults = Array.from({ length: 5 }, () => ({
      ok: true as const,
      console: ["hi"],
      result: undefined,
      callCount: 0,
    }));
    const { runner } = createMockScriptRunner(scriptResults);

    const result = await runCodeReplLoop({
      scriptRunner: runner,
      modelCall,
      input: "data",
      question: "q",
      config: { ...BASE_CONFIG, maxIterations: 3 },
    });

    expect(result.stopReason).toBe("max_turns");
    expect(result.metrics.turns).toBe(3);
  });

  test("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const modelCall = createMockModelCall([]);
    const { runner } = createMockScriptRunner([]);

    const result = await runCodeReplLoop({
      scriptRunner: runner,
      modelCall,
      input: "data",
      question: "q",
      config: BASE_CONFIG,
      signal: controller.signal,
    });

    expect(result.stopReason).toBe("interrupted");
  });

  test("emits events during execution", async () => {
    const modelCall = createMockModelCall(["No code block here."]);
    const { runner } = createMockScriptRunner([]);
    const events: Array<{ readonly kind: string }> = [];

    await runCodeReplLoop({
      scriptRunner: runner,
      modelCall,
      input: "data",
      question: "q",
      config: BASE_CONFIG,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(events.length).toBe(3); // turn_start, turn_end, done
    expect(events[0]?.kind).toBe("turn_start");
    expect(events[1]?.kind).toBe("turn_end");
    expect(events[2]?.kind).toBe("done");
  });

  test("host functions are wired to script runner correctly", async () => {
    const modelCall = createMockModelCall([
      "```javascript\nvar data = readInput(0, 10);\nconsole.log(data);\n```",
    ]);

    // Use a real runner that invokes host functions
    const realRunner: RlmScriptRunner = {
      run: async (config) => {
        // Verify host functions are present
        const readInputFn = config.hostFns.get("readInput");
        const inputInfoFn = config.hostFns.get("inputInfo");
        const submitFn = config.hostFns.get("SUBMIT");
        const llmQueryFn = config.hostFns.get("llm_query");
        const llmBatchFn = config.hostFns.get("llm_query_batched");

        expect(readInputFn).toBeDefined();
        expect(inputInfoFn).toBeDefined();
        expect(submitFn).toBeDefined();
        expect(llmQueryFn).toBeDefined();
        expect(llmBatchFn).toBeDefined();

        // Test readInput
        if (readInputFn === undefined) throw new Error("readInput not found");
        const data = await readInputFn({ offset: 0, length: 5 });
        expect(data).toBe("hello");

        // Test inputInfo
        if (inputInfoFn === undefined) throw new Error("inputInfo not found");
        const info = await inputInfoFn({});
        expect(info).toHaveProperty("format");

        // Test SUBMIT
        if (submitFn === undefined) throw new Error("SUBMIT not found");
        await submitFn({ answer: "result from host" });

        return { ok: true, console: ["hello"], result: undefined, callCount: 3 };
      },
    };

    const result = await runCodeReplLoop({
      scriptRunner: realRunner,
      modelCall,
      input: "hello world",
      question: "What is the first word?",
      config: BASE_CONFIG,
    });

    expect(result.answer).toBe("result from host");
    expect(result.stopReason).toBe("completed");
  });

  test("includes error output in history on script failure", async () => {
    const capturedMessages: InboundMessage[][] = [];

    // Justified `let`: counter for model call responses
    let modelCallIdx = 0;
    const responses = ["```javascript\nvar x = undefined.foo;\n```", "The final answer is done."];
    const modelCall = mock(async (req: { readonly messages: readonly InboundMessage[] }) => {
      capturedMessages.push([...(req.messages as InboundMessage[])]);
      const content = responses[modelCallIdx] ?? "";
      modelCallIdx++;
      return { content, model: "test-model", usage: { inputTokens: 10, outputTokens: 5 } };
    }) as unknown as ModelHandler;

    const { runner } = createMockScriptRunner([
      {
        ok: false,
        console: ["before error"],
        result: undefined,
        error: "Cannot read property 'foo' of undefined",
        callCount: 0,
      },
    ]);

    await runCodeReplLoop({
      scriptRunner: runner,
      modelCall,
      input: "data",
      question: "q",
      config: BASE_CONFIG,
    });

    // Second model call should have history with error
    const secondCallMessages = capturedMessages[1];
    expect(secondCallMessages).toBeDefined();
    if (secondCallMessages === undefined) throw new Error("no second call");
    const historyTexts = secondCallMessages.map((m) =>
      m.content.map((b) => (b.kind === "text" ? b.text : "")).join(""),
    );
    const allText = historyTexts.join("\n");
    expect(allText).toContain("Error:");
    expect(allText).toContain("Cannot read property");
  });
});

// Re-export for type-level reference in tests
type InboundMessage = import("@koi/core").InboundMessage;
