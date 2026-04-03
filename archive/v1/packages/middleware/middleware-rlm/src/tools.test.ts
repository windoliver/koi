import { describe, expect, mock, test } from "bun:test";
import type { ModelHandler } from "@koi/core";
import { createInputStore } from "./input-store.js";
import { createSemaphore } from "./semaphore.js";
import { createTokenTracker } from "./token-tracker.js";
import {
  createChunkTool,
  createExamineTool,
  createFinalTool,
  createInputInfoTool,
  createLlmQueryBatchedTool,
  createLlmQueryTool,
  createRlmQueryTool,
} from "./tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sampleInput = '{"name": "Alice", "items": [1, 2, 3]}';
const store = createInputStore(sampleInput, { chunkSize: 20, previewLength: 10 });

function createMockModelCall(response: string = "model response"): ModelHandler {
  return mock(() => Promise.resolve({ content: response, model: "test" }));
}

// ---------------------------------------------------------------------------
// input_info
// ---------------------------------------------------------------------------

describe("input_info tool", () => {
  test("returns correct metadata", () => {
    const tool = createInputInfoTool({ store });
    const result = tool.execute();
    expect(result.isError).toBe(false);
    const meta = result.output as Record<string, unknown>;
    expect(meta.format).toBe("json");
    expect(meta.sizeBytes).toBe(new TextEncoder().encode(sampleInput).length);
    expect(meta.totalChunks).toBe(Math.ceil(sampleInput.length / 20));
    expect(meta.structureHints).toContain("name");
    expect(meta.structureHints).toContain("items");
  });
});

// ---------------------------------------------------------------------------
// examine
// ---------------------------------------------------------------------------

describe("examine tool", () => {
  const tool = createExamineTool({ store });

  test("returns valid slice", () => {
    const result = tool.execute({ offset: 0, length: 6 });
    expect(result.isError).toBe(false);
    expect(result.output).toBe('{"name');
  });

  test("offset < 0 error", () => {
    const result = tool.execute({ offset: -1, length: 5 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("offset must be >= 0");
  });

  test("length > MAX_EXAMINE_LENGTH error", () => {
    const result = tool.execute({ offset: 0, length: 60_000 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("50000");
  });

  test("non-number offset error", () => {
    const result = tool.execute({ offset: "abc", length: 5 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("must be numbers");
  });

  test("offset > input length error", () => {
    const result = tool.execute({ offset: 999999, length: 5 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("exceeds input length");
  });
});

// ---------------------------------------------------------------------------
// chunk
// ---------------------------------------------------------------------------

describe("chunk tool", () => {
  const tool = createChunkTool({ store });

  test("returns valid chunk descriptors", () => {
    const result = tool.execute({ start_index: 0, end_index: 0 });
    expect(result.isError).toBe(false);
    const chunks = result.output as Array<Record<string, unknown>>;
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.index).toBe(0);
    expect(chunks[0]?.offset).toBe(0);
  });

  test("start > end error", () => {
    const result = tool.execute({ start_index: 5, end_index: 2 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("start_index must be <= end_index");
  });

  test("defaults to all chunks when no args", () => {
    const result = tool.execute({});
    expect(result.isError).toBe(false);
    const chunks = result.output as Array<Record<string, unknown>>;
    expect(chunks.length).toBe(store.metadata().totalChunks);
  });
});

// ---------------------------------------------------------------------------
// llm_query
// ---------------------------------------------------------------------------

describe("llm_query tool", () => {
  test("success returns model response", async () => {
    const modelCall = createMockModelCall("answer is 42");
    const tracker = createTokenTracker(100_000);
    const tool = createLlmQueryTool({ modelCall, tracker });

    const result = await tool.execute({ prompt: "What is the answer?" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("answer is 42");
  });

  test("empty prompt error", async () => {
    const modelCall = createMockModelCall();
    const tracker = createTokenTracker(100_000);
    const tool = createLlmQueryTool({ modelCall, tracker });

    const result = await tool.execute({ prompt: "" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("non-empty string");
  });

  test("model failure returns error string", async () => {
    const modelCall: ModelHandler = mock(() => Promise.reject(new Error("rate limited")));
    const tracker = createTokenTracker(100_000);
    const tool = createLlmQueryTool({ modelCall, tracker });

    const result = await tool.execute({ prompt: "test" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("rate limited");
  });

  test("tracks tokens from response", async () => {
    const modelCall: ModelHandler = mock(() =>
      Promise.resolve({
        content: "response",
        model: "test",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    );
    const tracker = createTokenTracker(100_000);
    const tool = createLlmQueryTool({ modelCall, tracker });

    await tool.execute({ prompt: "prompt" });
    expect(tracker.current()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// llm_query_batched
// ---------------------------------------------------------------------------

describe("llm_query_batched tool", () => {
  test("success returns array of responses", async () => {
    // let: counter for deterministic sequential responses
    let callCount = 0;
    const modelCall: ModelHandler = mock(() => {
      callCount++;
      return Promise.resolve({ content: `response-${String(callCount)}`, model: "test" });
    });
    const tracker = createTokenTracker(100_000);
    const semaphore = createSemaphore(5);
    const tool = createLlmQueryBatchedTool({ modelCall, tracker, semaphore });

    const result = await tool.execute({ prompts: ["a", "b", "c"] });
    expect(result.isError).toBe(false);
    const outputs = result.output as string[];
    expect(outputs).toHaveLength(3);
    expect(outputs.every((o) => o.startsWith("response-"))).toBe(true);
  });

  test("empty array error", async () => {
    const modelCall = createMockModelCall();
    const tracker = createTokenTracker(100_000);
    const semaphore = createSemaphore(5);
    const tool = createLlmQueryBatchedTool({ modelCall, tracker, semaphore });

    const result = await tool.execute({ prompts: [] });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("non-empty array");
  });

  test("> 50 items error", async () => {
    const modelCall = createMockModelCall();
    const tracker = createTokenTracker(100_000);
    const semaphore = createSemaphore(5);
    const tool = createLlmQueryBatchedTool({ modelCall, tracker, semaphore });

    const prompts = Array.from({ length: 51 }, (_, i) => `prompt ${String(i)}`);
    const result = await tool.execute({ prompts });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("50");
  });

  test("mixed types error", async () => {
    const modelCall = createMockModelCall();
    const tracker = createTokenTracker(100_000);
    const semaphore = createSemaphore(5);
    const tool = createLlmQueryBatchedTool({ modelCall, tracker, semaphore });

    const result = await tool.execute({ prompts: ["valid", 123] });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("must be strings");
  });

  test("concurrent execution respects semaphore", async () => {
    // let: mutable counter for concurrent tracking
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const modelCall: ModelHandler = mock(async () => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
      await new Promise((r) => setTimeout(r, 20));
      currentConcurrent--;
      return { content: "ok", model: "test" };
    });

    const tracker = createTokenTracker(100_000);
    const semaphore = createSemaphore(2);
    const tool = createLlmQueryBatchedTool({ modelCall, tracker, semaphore });

    await tool.execute({ prompts: ["a", "b", "c", "d"] });
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  test("order preserved despite concurrency", async () => {
    const modelCall: ModelHandler = mock(async (req) => {
      const text = req.messages[0]?.content[0];
      const prompt = text?.kind === "text" ? text.text : "";
      // Vary delay to test ordering
      const delay = prompt === "fast" ? 5 : 50;
      await new Promise((r) => setTimeout(r, delay));
      return { content: `result-${prompt}`, model: "test" };
    });

    const tracker = createTokenTracker(100_000);
    const semaphore = createSemaphore(5);
    const tool = createLlmQueryBatchedTool({ modelCall, tracker, semaphore });

    const result = await tool.execute({ prompts: ["slow", "fast", "slow"] });
    const outputs = result.output as string[];
    expect(outputs[0]).toBe("result-slow");
    expect(outputs[1]).toBe("result-fast");
    expect(outputs[2]).toBe("result-slow");
  });
});

// ---------------------------------------------------------------------------
// rlm_query
// ---------------------------------------------------------------------------

describe("rlm_query tool", () => {
  test("no spawn callback returns error", async () => {
    const tracker = createTokenTracker(100_000);
    const tool = createRlmQueryTool({
      tracker,
      depth: 0,
      startTime: Date.now(),
      timeBudgetMs: 60000,
    });

    const result = await tool.execute({ input: "some text" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not available");
  });

  test("success returns child answer", async () => {
    const tracker = createTokenTracker(100_000);
    const spawnRlmChild = mock(async () => ({ answer: "child answer", tokensUsed: 50 }));
    const tool = createRlmQueryTool({
      spawnRlmChild,
      tracker,
      depth: 0,
      startTime: Date.now(),
      timeBudgetMs: 60000,
    });

    const result = await tool.execute({ input: "sub-input" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("child answer");
  });

  test("child failure returns error string", async () => {
    const tracker = createTokenTracker(100_000);
    const spawnRlmChild = mock(async () => {
      throw new Error("child crashed");
    });
    const tool = createRlmQueryTool({
      spawnRlmChild,
      tracker,
      depth: 0,
      startTime: Date.now(),
      timeBudgetMs: 60000,
    });

    const result = await tool.execute({ input: "sub-input" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("child crashed");
  });

  test("budget forwarded correctly", async () => {
    const tracker = createTokenTracker(1000);
    tracker.addTokens(300);
    const spawnRlmChild = mock(async (req: { readonly remainingTokenBudget: number }) => {
      expect(req.remainingTokenBudget).toBe(700);
      return { answer: "ok", tokensUsed: 100 };
    });
    const tool = createRlmQueryTool({
      spawnRlmChild,
      tracker,
      depth: 2,
      startTime: Date.now(),
      timeBudgetMs: 60000,
    });

    await tool.execute({ input: "test" });

    const callArg = (spawnRlmChild as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg.depth).toBe(3);
    expect(callArg.remainingTokenBudget).toBe(700);
  });

  test("empty input returns error", async () => {
    const tracker = createTokenTracker(100_000);
    const tool = createRlmQueryTool({
      spawnRlmChild: mock(async () => ({ answer: "ok", tokensUsed: 0 })),
      tracker,
      depth: 0,
      startTime: Date.now(),
      timeBudgetMs: 60000,
    });

    const result = await tool.execute({ input: "" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("non-empty string");
  });

  test("time budget exhausted returns error without spawning", async () => {
    const tracker = createTokenTracker(100_000);
    const spawnRlmChild = mock(async () => ({ answer: "ok", tokensUsed: 0 }));
    const tool = createRlmQueryTool({
      spawnRlmChild,
      tracker,
      depth: 0,
      startTime: Date.now() - 120_000, // 2 minutes ago
      timeBudgetMs: 60_000, // 1 minute budget (already exhausted)
    });

    const result = await tool.execute({ input: "sub-input" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("time budget exhausted");
    expect(spawnRlmChild).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// shared_context
// ---------------------------------------------------------------------------

describe("shared_context tool", () => {
  test("returns message when no entries", () => {
    const { createSharedContextTool } = require("./tools.js");
    const tool = createSharedContextTool({ entries: () => [] });
    const result = tool.execute();
    expect(result.isError).toBe(false);
    expect(result.output).toContain("No shared findings");
  });

  test("returns joined entries when present", () => {
    const { createSharedContextTool } = require("./tools.js");
    const tool = createSharedContextTool({
      entries: () => ["Found API endpoint /users", "Found database schema"],
    });
    const result = tool.execute();
    expect(result.isError).toBe(false);
    expect(result.output).toContain("/users");
    expect(result.output).toContain("database schema");
  });
});

// ---------------------------------------------------------------------------
// FINAL
// ---------------------------------------------------------------------------

describe("FINAL tool", () => {
  test("callback invoked with answer", () => {
    const onFinal = mock((_answer: string) => {});
    const tool = createFinalTool({ onFinal });

    const result = tool.execute({ answer: "The answer is 42." });
    expect(result.isError).toBe(false);
    expect(onFinal).toHaveBeenCalledWith("The answer is 42.");
  });

  test("missing answer error", () => {
    const onFinal = mock((_answer: string) => {});
    const tool = createFinalTool({ onFinal });

    const result = tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("must be a string");
  });

  test("non-string answer error", () => {
    const onFinal = mock((_answer: string) => {});
    const tool = createFinalTool({ onFinal });

    const result = tool.execute({ answer: 42 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("must be a string");
  });

  test("empty answer error", () => {
    const onFinal = mock((_answer: string) => {});
    const tool = createFinalTool({ onFinal });

    const result = tool.execute({ answer: "" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("must not be empty");
  });
});
