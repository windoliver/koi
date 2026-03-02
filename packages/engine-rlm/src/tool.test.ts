import { describe, expect, mock, test } from "bun:test";
import type { ModelHandler } from "@koi/core";
import type { RlmToolConfig } from "./tool.js";
import { createRlmTool } from "./tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Model that calls FINAL on first turn with a fixed answer. */
function createFinalOnFirstTurnModel(answer: string): ModelHandler {
  return mock(async () => ({
    content: "Calling FINAL.",
    model: "test",
    metadata: {
      toolCalls: [{ toolName: "FINAL", callId: "call-1", input: { answer } }],
    },
  }));
}

/** Model that never gets called — used in validation tests. */
function createNoopModel(): ModelHandler {
  return mock(async () => ({ content: "", model: "test" }));
}

function createMinimalToolConfig(modelCall: ModelHandler): RlmToolConfig {
  return {
    modelCall,
    maxIterations: 5,
    maxInputBytes: 10_000,
    chunkSize: 100,
    contextWindowTokens: 10_000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRlmTool", () => {
  test("returns Tool with correct descriptor", () => {
    const tool = createRlmTool(createMinimalToolConfig(createNoopModel()));

    expect(tool.descriptor.name).toBe("rlm_process");
    expect(tool.trustTier).toBe("verified");
    expect(tool.descriptor.tags).toEqual(["rlm", "large-input", "recursive"]);
  });

  test("returns answer for valid input and question", async () => {
    const modelCall = createFinalOnFirstTurnModel("The answer is 42.");
    const tool = createRlmTool(createMinimalToolConfig(modelCall));

    const result = await tool.execute({
      input: "Some large document content here.",
      question: "What is this about?",
    });

    expect(typeof result).toBe("string");
    expect(result).toBe("The answer is 42.");
  });

  test("rejects missing input field", async () => {
    const tool = createRlmTool(createMinimalToolConfig(createNoopModel()));

    const result = await tool.execute({ question: "What?" });

    expect(result).toEqual({ error: "Missing required field: input", code: "RLM_ERROR" });
  });

  test("rejects missing question field", async () => {
    const tool = createRlmTool(createMinimalToolConfig(createNoopModel()));

    const result = await tool.execute({ input: "some text" });

    expect(result).toEqual({ error: "Missing required field: question", code: "RLM_ERROR" });
  });

  test("rejects non-string input", async () => {
    const tool = createRlmTool(createMinimalToolConfig(createNoopModel()));

    const result = await tool.execute({ input: 42, question: "What?" });

    expect(result).toEqual({ error: "Field 'input' must be a string", code: "RLM_ERROR" });
  });

  test("rejects empty question", async () => {
    const tool = createRlmTool(createMinimalToolConfig(createNoopModel()));

    const result = await tool.execute({ input: "data", question: "" });

    expect(result).toEqual({ error: "Field 'question' must not be empty", code: "RLM_ERROR" });
  });

  test("rejects empty input", async () => {
    const tool = createRlmTool(createMinimalToolConfig(createNoopModel()));

    const result = await tool.execute({ input: "", question: "What?" });

    expect(result).toEqual({ error: "Field 'input' must not be empty", code: "RLM_ERROR" });
  });

  test("handles adapter error gracefully", async () => {
    const failingModel: ModelHandler = mock(async () => {
      throw new Error("Model connection lost");
    });
    const tool = createRlmTool(createMinimalToolConfig(failingModel));

    const result = await tool.execute({
      input: "some data",
      question: "Analyze this",
    });

    expect(result).toEqual(expect.objectContaining({ code: "RLM_ERROR" }));
    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining("Model connection lost") }),
    );
  });

  test("respects AbortSignal cancellation (pre-aborted)", async () => {
    const modelCall = createFinalOnFirstTurnModel("unused");
    const tool = createRlmTool(createMinimalToolConfig(modelCall));

    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute(
      { input: "data", question: "What?" },
      { signal: controller.signal },
    );

    expect(result).toEqual({ error: "Aborted before execution", code: "RLM_ERROR" });
  });
});
