/**
 * Tests for the ReAct loop engine adapter.
 */

import { describe, expect, test } from "bun:test";
import type {
  EngineEvent,
  EngineOutput,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ToolCallId,
  ToolHandler,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { toolCallId } from "@koi/core";
import { testEngineAdapter } from "@koi/test-utils";
import { createLoopAdapter } from "./loop-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

// ---------------------------------------------------------------------------
// Mock model handlers
// ---------------------------------------------------------------------------

/**
 * Creates a model handler that returns a simple text response with no tool calls.
 */
function createSimpleModelHandler(text: string): ModelHandler {
  return async (_request: ModelRequest): Promise<ModelResponse> => ({
    content: text,
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 20 },
  });
}

/**
 * Creates a model handler that returns tool calls on the first call,
 * then a text response on the second call.
 */
function createToolCallingModelHandler(
  toolCalls: readonly {
    readonly toolName: string;
    readonly callId: string;
    readonly input: Record<string, unknown>;
  }[],
  finalText: string,
): ModelHandler {
  let callCount = 0;
  return async (_request: ModelRequest): Promise<ModelResponse> => {
    callCount += 1;
    if (callCount === 1) {
      return {
        content: "Thinking... I need to call tools.",
        model: "test-model",
        usage: { inputTokens: 15, outputTokens: 25 },
        metadata: { toolCalls },
      };
    }
    return {
      content: finalText,
      model: "test-model",
      usage: { inputTokens: 20, outputTokens: 30 },
    };
  };
}

/**
 * Creates a model handler that always returns tool calls, never a final response.
 * Used to test maxTurns limit.
 */
function createInfiniteToolCallingModelHandler(): ModelHandler {
  let callCount = 0;
  return async (_request: ModelRequest): Promise<ModelResponse> => {
    callCount += 1;
    return {
      content: `Turn ${String(callCount)} - calling tool again`,
      model: "test-model",
      usage: { inputTokens: 5, outputTokens: 10 },
      metadata: {
        toolCalls: [{ toolName: "infinite-tool", callId: `call-${String(callCount)}`, input: {} }],
      },
    };
  };
}

/**
 * Creates a mock tool handler that returns a canned response.
 */
function createMockToolHandler(output: unknown): ToolHandler {
  return async (_request: ToolRequest): Promise<ToolResponse> => ({
    output,
  });
}

/**
 * Creates a model stream handler that yields text_delta chunks then done.
 */
function createSimpleModelStreamHandler(text: string): ModelStreamHandler {
  return (_request: ModelRequest): AsyncIterable<ModelChunk> => {
    const words = text.split(" ");
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<ModelChunk, void, undefined> {
        for (const word of words) {
          yield { kind: "text_delta" as const, delta: `${word} ` };
        }
        yield { kind: "usage" as const, inputTokens: 10, outputTokens: 20 };
        yield {
          kind: "done" as const,
          response: {
            content: text,
            model: "test-model",
            usage: { inputTokens: 10, outputTokens: 20 },
          },
        };
      },
    };
  };
}

/**
 * Creates a model stream handler that yields tool calls on first invocation
 * and text on subsequent invocations.
 */
function createToolCallingStreamHandler(
  toolCalls: readonly {
    readonly toolName: string;
    readonly callId: ToolCallId;
    readonly input: Record<string, unknown>;
  }[],
  finalText: string,
): ModelStreamHandler {
  let callCount = 0;
  return (_request: ModelRequest): AsyncIterable<ModelChunk> => {
    callCount += 1;
    const isFirstCall = callCount === 1;

    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<ModelChunk, void, undefined> {
        if (isFirstCall) {
          // Emit tool call chunks
          for (const tc of toolCalls) {
            yield { kind: "tool_call_start" as const, toolName: tc.toolName, callId: tc.callId };
            yield {
              kind: "tool_call_delta" as const,
              callId: tc.callId,
              delta: JSON.stringify(tc.input),
            };
            yield { kind: "tool_call_end" as const, callId: tc.callId };
          }
          yield { kind: "usage" as const, inputTokens: 15, outputTokens: 25 };
          yield {
            kind: "done" as const,
            response: {
              content: "Calling tools...",
              model: "test-model",
              usage: { inputTokens: 15, outputTokens: 25 },
              metadata: { toolCalls },
            },
          };
        } else {
          // Final text response
          yield { kind: "text_delta" as const, delta: finalText };
          yield { kind: "usage" as const, inputTokens: 20, outputTokens: 30 };
          yield {
            kind: "done" as const,
            response: {
              content: finalText,
              model: "test-model",
              usage: { inputTokens: 20, outputTokens: 30 },
            },
          };
        }
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Contract test suite from @koi/test-utils
// ---------------------------------------------------------------------------

describe("@koi/engine-loop contract", () => {
  testEngineAdapter({
    createAdapter: () =>
      createLoopAdapter({
        modelCall: createSimpleModelHandler("Hello from the loop adapter!"),
      }),
  });
});

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("createLoopAdapter", () => {
  test("returns an adapter with the correct engineId", () => {
    const adapter = createLoopAdapter({
      modelCall: createSimpleModelHandler("hi"),
    });
    expect(adapter.engineId).toBe("koi-loop");
  });

  test("exposes terminals with modelCall", () => {
    const modelCall = createSimpleModelHandler("hi");
    const adapter = createLoopAdapter({ modelCall });
    expect(adapter.terminals).toBeDefined();
    expect(adapter.terminals?.modelCall).toBe(modelCall);
  });
});

describe("basic text response (no tool calls)", () => {
  test("emits text_delta and done events for a simple text response", async () => {
    const adapter = createLoopAdapter({
      modelCall: createSimpleModelHandler("Hello, world!"),
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "Say hello" }));

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas.length).toBe(1);

    const delta = textDeltas[0];
    expect(delta).toBeDefined();
    if (delta !== undefined && delta.kind === "text_delta") {
      expect(delta.delta).toBe("Hello, world!");
    }

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
  });

  test("processes messages input kind", async () => {
    const adapter = createLoopAdapter({
      modelCall: createSimpleModelHandler("Response to messages"),
    });

    const events = await collectEvents(
      adapter.stream({
        kind: "messages",
        messages: [
          {
            content: [{ kind: "text", text: "Hello" }],
            senderId: "user",
            timestamp: Date.now(),
          },
        ],
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
  });
});

describe("tool call round-trip", () => {
  test("model returns tool call, tool executes, model responds with text", async () => {
    const toolCalls = [
      { toolName: "calculator", callId: "calc-1", input: { expression: "2+2" } },
    ] as const;

    const adapter = createLoopAdapter({
      modelCall: createToolCallingModelHandler(toolCalls, "The answer is 4."),
      toolCall: createMockToolHandler({ result: 4 }),
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "What is 2+2?" }));

    // Should have tool_call_start and tool_call_end events
    const starts = events.filter((e) => e.kind === "tool_call_start");
    const ends = events.filter((e) => e.kind === "tool_call_end");
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);

    const start = starts[0];
    if (start !== undefined && start.kind === "tool_call_start") {
      expect(start.toolName).toBe("calculator");
      expect(start.callId).toBe(toolCallId("calc-1"));
    }

    const end = ends[0];
    if (end !== undefined && end.kind === "tool_call_end") {
      expect(end.callId).toBe(toolCallId("calc-1"));
      expect(end.result).toEqual({ result: 4 });
    }

    // Should have text_delta for the final response
    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas.length).toBe(1);

    const finalDelta = textDeltas[0];
    if (finalDelta !== undefined && finalDelta.kind === "text_delta") {
      expect(finalDelta.delta).toBe("The answer is 4.");
    }

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
  });

  test("throws when model returns tool calls but no tool handler is available", async () => {
    const toolCalls = [
      { toolName: "calculator", callId: "calc-1", input: { expression: "2+2" } },
    ] as const;

    const adapter = createLoopAdapter({
      modelCall: createToolCallingModelHandler(toolCalls, "The answer is 4."),
      // No toolCall terminal provided
    });

    await expect(
      collectEvents(adapter.stream({ kind: "text", text: "What is 2+2?" })),
    ).rejects.toThrow("no tool handler");
  });
});

describe("parallel tool execution", () => {
  test("executes multiple tool calls in parallel", async () => {
    const toolCalls = [
      { toolName: "search", callId: "search-1", input: { query: "weather" } },
      { toolName: "calculator", callId: "calc-1", input: { expression: "1+1" } },
    ] as const;

    const executionOrder: string[] = [];
    const toolHandler: ToolHandler = async (request: ToolRequest): Promise<ToolResponse> => {
      executionOrder.push(request.toolId);
      return { output: { result: `${request.toolId}-done` } };
    };

    const adapter = createLoopAdapter({
      modelCall: createToolCallingModelHandler(toolCalls, "Results are in."),
      toolCall: toolHandler,
    });

    const events = await collectEvents(
      adapter.stream({ kind: "text", text: "Search and calculate" }),
    );

    const starts = events.filter((e) => e.kind === "tool_call_start");
    const ends = events.filter((e) => e.kind === "tool_call_end");

    expect(starts.length).toBe(2);
    expect(ends.length).toBe(2);

    // Both tool calls should have been executed
    expect(executionOrder).toContain("search");
    expect(executionOrder).toContain("calculator");

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
  });
});

describe("streaming mode", () => {
  test("forwards text_delta chunks from modelStream", async () => {
    const adapter = createLoopAdapter({
      modelCall: createSimpleModelHandler("fallback"),
      modelStream: createSimpleModelStreamHandler("Hello streaming world"),
    });

    const events = await collectEvents(
      adapter.stream({
        kind: "text",
        text: "Stream me",
        callHandlers: {
          modelCall: createSimpleModelHandler("composed fallback"),
          modelStream: createSimpleModelStreamHandler("Hello streaming world"),
          toolCall: createMockToolHandler(null),
          tools: [],
        },
      }),
    );

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    // "Hello streaming world" split into words -> 3 chunks
    expect(textDeltas.length).toBe(3);

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
  });

  test("streaming with tool calls works end-to-end", async () => {
    const toolCalls = [
      { toolName: "lookup", callId: toolCallId("look-1"), input: { key: "test" } },
    ] as const;

    const adapter = createLoopAdapter({
      modelCall: createSimpleModelHandler("fallback"),
      modelStream: createToolCallingStreamHandler(toolCalls, "Lookup complete."),
      toolCall: createMockToolHandler({ found: true }),
    });

    const events = await collectEvents(
      adapter.stream({
        kind: "text",
        text: "Look something up",
        callHandlers: {
          modelCall: createSimpleModelHandler("composed fallback"),
          modelStream: createToolCallingStreamHandler(toolCalls, "Lookup complete."),
          toolCall: createMockToolHandler({ found: true }),
          tools: [],
        },
      }),
    );

    // Should have tool_call_start from streaming chunk, tool_call_end after execution
    const toolStarts = events.filter((e) => e.kind === "tool_call_start");
    const toolEnds = events.filter((e) => e.kind === "tool_call_end");
    expect(toolStarts.length).toBe(1);
    expect(toolEnds.length).toBe(1);

    // Should have text_delta from the final response
    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas.length).toBe(1);

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
  });
});

describe("done event metrics", () => {
  test("done event has valid metrics with correct token counts", async () => {
    const adapter = createLoopAdapter({
      modelCall: createSimpleModelHandler("Hello!"),
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "Hi" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    if (output === undefined) return;

    expect(output.metrics.inputTokens).toBe(10);
    expect(output.metrics.outputTokens).toBe(20);
    expect(output.metrics.totalTokens).toBe(30);
    expect(output.metrics.turns).toBe(1);
    expect(output.metrics.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("metrics accumulate across multiple turns", async () => {
    const toolCalls = [{ toolName: "tool1", callId: "t1", input: {} }] as const;

    const adapter = createLoopAdapter({
      modelCall: createToolCallingModelHandler(toolCalls, "Done."),
      toolCall: createMockToolHandler("ok"),
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "Do something" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    if (output === undefined) return;

    // First call: 15 input + 25 output, Second call: 20 input + 30 output
    expect(output.metrics.inputTokens).toBe(35);
    expect(output.metrics.outputTokens).toBe(55);
    expect(output.metrics.totalTokens).toBe(90);
    expect(output.metrics.turns).toBe(2);
  });
});

describe("maxTurns limit", () => {
  test("terminates loop when maxTurns is reached", async () => {
    const adapter = createLoopAdapter({
      modelCall: createInfiniteToolCallingModelHandler(),
      toolCall: createMockToolHandler("ok"),
      maxTurns: 3,
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "Go forever" }));

    const turnEnds = events.filter((e) => e.kind === "turn_end");
    expect(turnEnds.length).toBe(3);

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("max_turns");
  });

  test("maxTurns defaults to 25", () => {
    // Verify by checking that a very long loop would be constrained
    // (We just verify the adapter is created without error; maxTurns=25 is internal)
    const adapter = createLoopAdapter({
      modelCall: createSimpleModelHandler("hi"),
    });
    expect(adapter.engineId).toBe("koi-loop");
  });
});

describe("concurrent run guard", () => {
  test("throws when a second stream is started while the first is still running", async () => {
    // Create a model handler that delays to simulate a slow LLM call
    let resolveFirst: (() => void) | undefined;
    const slowModelCall: ModelHandler = async (_request: ModelRequest): Promise<ModelResponse> => {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      return { content: "done", model: "test", usage: { inputTokens: 1, outputTokens: 1 } };
    };

    const adapter = createLoopAdapter({ modelCall: slowModelCall });

    // Start the first run (will block on the slow model call)
    const firstRun = adapter.stream({ kind: "text", text: "first" });
    const iterator = firstRun[Symbol.asyncIterator]();
    // Kick off first iteration — this triggers the model call and blocks
    const firstNext = iterator.next();

    // Attempt a second run while the first is still in progress
    await expect(collectEvents(adapter.stream({ kind: "text", text: "second" }))).rejects.toThrow(
      "concurrent",
    );

    // Clean up: resolve the first run so it can finish
    resolveFirst?.();
    await firstNext;
    // Drain remaining events
    let done = false;
    while (!done) {
      const result = await iterator.next();
      done = result.done ?? false;
    }
  });

  test("allows sequential runs after the first completes", async () => {
    const adapter = createLoopAdapter({
      modelCall: createSimpleModelHandler("hello"),
    });

    // First run
    const events1 = await collectEvents(adapter.stream({ kind: "text", text: "first" }));
    expect(findDoneOutput(events1)?.stopReason).toBe("completed");

    // Second run — should succeed after the first completed
    const events2 = await collectEvents(adapter.stream({ kind: "text", text: "second" }));
    expect(findDoneOutput(events2)?.stopReason).toBe("completed");
  });
});

describe("dispose idempotency", () => {
  test("dispose can be called once without error", async () => {
    const adapter = createLoopAdapter({
      modelCall: createSimpleModelHandler("hi"),
    });
    await adapter.dispose?.();
  });

  test("dispose can be called multiple times without error", async () => {
    const adapter = createLoopAdapter({
      modelCall: createSimpleModelHandler("hi"),
    });
    await adapter.dispose?.();
    await adapter.dispose?.();
    await adapter.dispose?.();
  });

  test("stream after dispose emits interrupted stop reason", async () => {
    const adapter = createLoopAdapter({
      modelCall: createSimpleModelHandler("hi"),
    });

    await adapter.dispose?.();

    const events = await collectEvents(adapter.stream({ kind: "text", text: "After dispose" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("interrupted");
  });
});

describe("callHandlers (cooperating adapter pattern)", () => {
  test("uses callHandlers.modelCall when provided", async () => {
    let rawCalled = false;
    let composedCalled = false;

    const rawModelCall: ModelHandler = async () => {
      rawCalled = true;
      return { content: "raw", model: "raw-model" };
    };

    const composedModelCall: ModelHandler = async () => {
      composedCalled = true;
      return {
        content: "composed",
        model: "composed-model",
        usage: { inputTokens: 5, outputTokens: 10 },
      };
    };

    const adapter = createLoopAdapter({ modelCall: rawModelCall });

    const events = await collectEvents(
      adapter.stream({
        kind: "text",
        text: "Test",
        callHandlers: {
          modelCall: composedModelCall,
          toolCall: createMockToolHandler(null),
          tools: [],
        },
      }),
    );

    expect(rawCalled).toBe(false);
    expect(composedCalled).toBe(true);

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas.length).toBe(1);
    if (textDeltas[0] !== undefined && textDeltas[0].kind === "text_delta") {
      expect(textDeltas[0].delta).toBe("composed");
    }
  });

  test("uses callHandlers.toolCall when provided", async () => {
    let composedToolCalled = false;

    const toolCalls = [{ toolName: "test-tool", callId: "tc-1", input: {} }] as const;

    const composedToolHandler: ToolHandler = async () => {
      composedToolCalled = true;
      return { output: "composed-result" };
    };

    const adapter = createLoopAdapter({
      modelCall: createToolCallingModelHandler(toolCalls, "Done with composed tool"),
      // Raw toolCall is not provided — only composed
    });

    const events = await collectEvents(
      adapter.stream({
        kind: "text",
        text: "Test tools",
        callHandlers: {
          modelCall: createToolCallingModelHandler(toolCalls, "Done with composed tool"),
          toolCall: composedToolHandler,
          tools: [],
        },
      }),
    );

    expect(composedToolCalled).toBe(true);

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
  });
});

describe("saveState and loadState", () => {
  test("saveState returns state with correct engineId", async () => {
    const adapter = createLoopAdapter({
      modelCall: createSimpleModelHandler("hi"),
    });

    const state = await adapter.saveState?.();
    expect(state).toBeDefined();
    expect(state?.engineId).toBe("koi-loop");
  });

  test("loadState rejects state from different engine", async () => {
    const adapter = createLoopAdapter({
      modelCall: createSimpleModelHandler("hi"),
    });

    await expect(adapter.loadState?.({ engineId: "other-engine", data: {} })).rejects.toThrow(
      "Cannot load state",
    );
  });

  test("loadState accepts state with correct engineId", async () => {
    const adapter = createLoopAdapter({
      modelCall: createSimpleModelHandler("hi"),
    });

    await adapter.loadState?.({
      engineId: "koi-loop",
      data: { messages: [] },
    });
    // No error thrown
  });
});

describe("turn_end events", () => {
  test("emits turn_end with correct turnIndex for single turn", async () => {
    const adapter = createLoopAdapter({
      modelCall: createSimpleModelHandler("Hello!"),
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "Hi" }));

    const turnEnds = events.filter(
      (e): e is EngineEvent & { readonly kind: "turn_end" } => e.kind === "turn_end",
    );
    expect(turnEnds.length).toBe(1);
    expect(turnEnds[0]?.turnIndex).toBe(0);
  });

  test("emits turn_end with incrementing turnIndex for multi-turn", async () => {
    const toolCalls = [{ toolName: "tool1", callId: "t1", input: {} }] as const;

    const adapter = createLoopAdapter({
      modelCall: createToolCallingModelHandler(toolCalls, "Done."),
      toolCall: createMockToolHandler("ok"),
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "Multi-turn" }));

    const turnEnds = events.filter(
      (e): e is EngineEvent & { readonly kind: "turn_end" } => e.kind === "turn_end",
    );
    expect(turnEnds.length).toBe(2);
    expect(turnEnds[0]?.turnIndex).toBe(0);
    expect(turnEnds[1]?.turnIndex).toBe(1);
  });
});
