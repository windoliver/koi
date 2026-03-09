import { describe, expect, mock, test } from "bun:test";
import type {
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ToolRequest,
  TurnContext,
} from "@koi/core";
import { createRlmMiddleware } from "./rlm.js";
import { RLM_PROCESS_TOOL_NAME } from "./rlm-tool-descriptor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_CTX = { session: { sessionId: "test-session-1" } } as TurnContext;

function createPassthroughNext(): ModelHandler {
  return mock(async (_request: ModelRequest) => {
    return { content: "model response", model: "test" } satisfies ModelResponse;
  });
}

/** Narrow result and fail test if undefined. */
function defined<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  // biome-ignore lint/style/noNonNullAssertion: test helper after expect guard
  return value!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRlmMiddleware", () => {
  test("injects rlm_process tool in wrapModelCall", async () => {
    const mw = createRlmMiddleware();
    const next = createPassthroughNext();

    await mw.wrapModelCall?.(STUB_CTX, { messages: [] }, next);

    expect(next).toHaveBeenCalledTimes(1);
    const calledRequest = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
    const toolNames = calledRequest.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain(RLM_PROCESS_TOOL_NAME);
  });

  test("passes through non-rlm tool calls", async () => {
    const mw = createRlmMiddleware();
    const nextTool = mock(async (_req: ToolRequest) => ({
      output: "passthrough result",
    }));

    const result = defined(
      await mw.wrapToolCall?.(STUB_CTX, { toolId: "other_tool", input: {} }, nextTool),
    );
    expect(result.output).toBe("passthrough result");
    expect(nextTool).toHaveBeenCalledTimes(1);
  });

  test("returns error for missing input", async () => {
    const mw = createRlmMiddleware();
    const next = createPassthroughNext();

    // Capture model handler first
    await mw.wrapModelCall?.(STUB_CTX, { messages: [] }, next);

    const result = defined(
      await mw.wrapToolCall?.(
        STUB_CTX,
        { toolId: RLM_PROCESS_TOOL_NAME, input: { question: "What?" } },
        mock(async () => ({ output: "nope" })),
      ),
    );

    const output = result.output as Record<string, unknown>;
    expect(output.code).toBe("RLM_ERROR");
  });

  test("returns error for missing question", async () => {
    const mw = createRlmMiddleware();
    const next = createPassthroughNext();

    await mw.wrapModelCall?.(STUB_CTX, { messages: [] }, next);

    const result = defined(
      await mw.wrapToolCall?.(
        STUB_CTX,
        { toolId: RLM_PROCESS_TOOL_NAME, input: { input: "data" } },
        mock(async () => ({ output: "nope" })),
      ),
    );

    const output = result.output as Record<string, unknown>;
    expect(output.code).toBe("RLM_ERROR");
  });

  test("returns error when no model handler captured", async () => {
    const mw = createRlmMiddleware();

    // Don't call wrapModelCall first
    const result = defined(
      await mw.wrapToolCall?.(
        STUB_CTX,
        { toolId: RLM_PROCESS_TOOL_NAME, input: { input: "data", question: "What?" } },
        mock(async () => ({ output: "nope" })),
      ),
    );

    const output = result.output as Record<string, unknown>;
    expect(output.code).toBe("RLM_ERROR");
    expect(output.error).toContain("captured model handler");
  });

  test("intercepts rlm_process and runs REPL", async () => {
    const mw = createRlmMiddleware({ maxIterations: 5, maxInputBytes: 10_000, chunkSize: 100 });

    // Create a model that calls FINAL on every REPL call
    const innerModel: ModelHandler = mock(async () => ({
      content: "analyzing...",
      model: "test",
      metadata: {
        toolCalls: [{ toolName: "FINAL", callId: "f1", input: { answer: "The answer is 42." } }],
      },
    }));

    // Capture the model handler
    await mw.wrapModelCall?.(STUB_CTX, { messages: [] }, innerModel);

    const result = defined(
      await mw.wrapToolCall?.(
        STUB_CTX,
        {
          toolId: RLM_PROCESS_TOOL_NAME,
          input: { input: "Some large document content.", question: "What is this?" },
        },
        mock(async () => ({ output: "should not reach" })),
      ),
    );

    expect(result.output).toBe("The answer is 42.");
    expect(result.metadata).toBeDefined();
  });

  test("rejects invalid config", () => {
    expect(() => createRlmMiddleware({ maxIterations: -1 })).toThrow();
  });

  test("has correct name and priority", () => {
    const mw = createRlmMiddleware({ priority: 500 });
    expect(mw.name).toBe("rlm");
    expect(mw.priority).toBe(500);
  });

  test("uses default priority of 300", () => {
    const mw = createRlmMiddleware();
    expect(mw.priority).toBe(300);
  });

  test("describeCapabilities returns label", () => {
    const mw = createRlmMiddleware();
    const cap = mw.describeCapabilities?.(STUB_CTX);
    expect(cap).toBeDefined();
    expect(cap?.label).toBe("rlm");
  });
});
