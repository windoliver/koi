import { describe, expect, test } from "bun:test";
import type {
  ComposedCallHandlers,
  EngineEvent,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ToolCallId,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { runTurn } from "./turn-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callId(id: string): ToolCallId {
  return id as ToolCallId;
}

async function collect(stream: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

const DONE_RESPONSE: ModelResponse = {
  content: "",
  model: "test-model",
  usage: { inputTokens: 10, outputTokens: 5 },
} as const;

function createTextStream(text: string): () => AsyncIterable<ModelChunk> {
  return () => textStream(text);
}

async function* textStream(text: string): AsyncIterable<ModelChunk> {
  yield { kind: "text_delta", delta: text };
  yield { kind: "done", response: DONE_RESPONSE };
}

function createToolCallStream(
  toolName: string,
  toolCallId: string,
  args: string,
): () => AsyncIterable<ModelChunk> {
  return () => toolCallStreamGen(toolName, toolCallId, args);
}

async function* toolCallStreamGen(
  toolName: string,
  id: string,
  args: string,
): AsyncIterable<ModelChunk> {
  yield { kind: "tool_call_start", toolName, callId: callId(id) };
  yield { kind: "tool_call_delta", callId: callId(id), delta: args };
  yield { kind: "tool_call_end", callId: callId(id) };
  yield { kind: "done", response: DONE_RESPONSE };
}

/** Shorthand for declaring a tool descriptor in tests. */
function toolDesc(name: string): {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, never>;
} {
  return { name, description: "", inputSchema: {} };
}

function createMockHandlers(options: {
  readonly modelStreams: ReadonlyArray<() => AsyncIterable<ModelChunk>>;
  readonly toolCall?: (request: ToolRequest) => Promise<ToolResponse>;
  readonly tools?: ComposedCallHandlers["tools"];
}): ComposedCallHandlers {
  // let justified: mutable call counter for cycling through modelStreams
  let streamCallIndex = 0;

  return {
    modelCall: async (_request: ModelRequest): Promise<ModelResponse> => DONE_RESPONSE,
    modelStream: (_request: ModelRequest): AsyncIterable<ModelChunk> => {
      const streamFactory = options.modelStreams[streamCallIndex];
      if (streamFactory === undefined) {
        throw new Error(`Unexpected model stream call #${streamCallIndex}`);
      }
      streamCallIndex += 1;
      return streamFactory();
    },
    toolCall:
      options.toolCall ??
      (async (_request: ToolRequest): Promise<ToolResponse> => ({
        output: "tool-result",
      })),
    tools: options.tools ?? [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runTurn", () => {
  test("single-turn text -> done", async () => {
    const handlers = createMockHandlers({
      modelStreams: [createTextStream("hello world")],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["turn_start", "text_delta", "turn_end", "done"]);

    // Verify turn_start
    expect(events[0]).toMatchObject({ kind: "turn_start", turnIndex: 0 });

    // Verify done
    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("completed");
      expect(done.output.metrics.turns).toBe(1);
    }
  });

  test("tool call -> continue -> done", async () => {
    const toolCalls: string[] = [];
    const handlers = createMockHandlers({
      modelStreams: [
        // Turn 0: model returns a tool call
        createToolCallStream("readFile", "tc-1", '{"path":"/foo"}'),
        // Turn 1: model returns text
        createTextStream("done reading"),
      ],
      toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
        toolCalls.push(request.toolId);
        return { output: "file-content" };
      },
      tools: [toolDesc("readFile")],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      // Turn 0
      "turn_start",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "tool_result",
      "turn_end",
      // Turn 1
      "turn_start",
      "text_delta",
      "turn_end",
      // Final
      "done",
    ]);

    // Verify tool was called
    expect(toolCalls).toEqual(["readFile"]);

    // Verify turn indices
    expect(events[0]).toMatchObject({ kind: "turn_start", turnIndex: 0 });
    expect(events[6]).toMatchObject({ kind: "turn_start", turnIndex: 1 });

    // Verify done
    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("completed");
      expect(done.output.metrics.turns).toBe(2);
    }
  });

  test("abort signal -> interrupted done", async () => {
    const controller = new AbortController();

    // Model stream that aborts after yielding first delta
    async function* abortingStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "partial" };
      controller.abort();
      // Yield more — runner should check abort and stop
      yield { kind: "text_delta", delta: " more" };
      yield { kind: "done", response: DONE_RESPONSE };
    }

    const handlers = createMockHandlers({
      modelStreams: [() => abortingStream()],
    });

    const events = await collect(
      runTurn({
        callHandlers: handlers,
        messages: [],
        signal: controller.signal,
      }),
    );

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("interrupted");
    }
  });

  test("max turns -> max_turns stop reason", async () => {
    const handlers = createMockHandlers({
      modelStreams: [
        // Turn 0: always returns tool calls
        createToolCallStream("readFile", "tc-1", '{"path":"/a"}'),
        // Turn 1 would be another tool call, but maxTurns=1 stops it
      ],
      tools: [toolDesc("readFile")],
    });

    const events = await collect(
      runTurn({
        callHandlers: handlers,
        messages: [],
        maxTurns: 1,
      }),
    );

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("max_turns");
    }
  });

  test("model error produces error done", async () => {
    async function* errorStream(): AsyncIterable<ModelChunk> {
      yield { kind: "error", message: "rate limited" };
    }

    const handlers = createMockHandlers({
      modelStreams: [() => errorStream()],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("error");
    }
  });

  test("model stream throws produces error done", async () => {
    async function* throwingStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "partial" };
      throw new Error("connection reset");
    }

    const handlers = createMockHandlers({
      modelStreams: [() => throwingStream()],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("error");
    }
  });

  test("non-streaming fallback uses modelCall", async () => {
    const handlers: ComposedCallHandlers = {
      modelCall: async (_request: ModelRequest): Promise<ModelResponse> => ({
        content: "hello from modelCall",
        model: "test-model",
        usage: { inputTokens: 5, outputTokens: 3 },
      }),
      // No modelStream — runner should fall back to modelCall
      toolCall: async (_request: ToolRequest): Promise<ToolResponse> => ({
        output: "unused",
      }),
      tools: [],
    };

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["turn_start", "text_delta", "turn_end", "done"]);

    const textDelta = events.find((e) => e.kind === "text_delta");
    if (textDelta?.kind === "text_delta") {
      expect(textDelta.delta).toBe("hello from modelCall");
    }
  });

  test("tool execution error produces error done", async () => {
    const handlers = createMockHandlers({
      modelStreams: [createToolCallStream("failTool", "tc-1", '{"x":1}')],
      toolCall: async (_request: ToolRequest): Promise<ToolResponse> => {
        throw new Error("tool exploded");
      },
      tools: [toolDesc("failTool")],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("error");
    }
  });

  test("#1742: aborting tool execution emits exactly one turn_end (no duplicate)", async () => {
    // Regression for a hypothesized round-4 review concern: the catch
    // block's `yield turn_end` followed by `break` must not also fall
    // through to the trailing unconditional `yield turn_end` at the
    // bottom of the while body. Verifies the abort path emits exactly
    // one turn_end and exactly one done.
    const controller = new AbortController();
    const handlers: ComposedCallHandlers = {
      modelCall: async (): Promise<ModelResponse> => DONE_RESPONSE,
      modelStream: (): AsyncIterable<ModelChunk> =>
        toolCallStreamGen("failTool", "tc-abort-once", '{"x":1}'),
      toolCall: async (): Promise<ToolResponse> => {
        controller.abort();
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
      tools: [toolDesc("failTool")],
    };

    const events = await collect(
      runTurn({ callHandlers: handlers, messages: [], signal: controller.signal }),
    );

    const turnEnds = events.filter((e) => e.kind === "turn_end");
    const dones = events.filter((e) => e.kind === "done");
    expect(turnEnds).toHaveLength(1);
    expect(dones).toHaveLength(1);
  });

  test("#1742: tool throw on aborted signal terminates as interrupted; no re-prompt", async () => {
    // Cancellation must short-circuit the synthetic-recovery path so users
    // who interrupt mid-tool don't get an extra model call after stop.
    const modelCallRequests: ModelRequest[] = [];
    const controller = new AbortController();
    const handlers: ComposedCallHandlers = {
      modelCall: async (): Promise<ModelResponse> => DONE_RESPONSE,
      modelStream: (req: ModelRequest): AsyncIterable<ModelChunk> => {
        modelCallRequests.push(req);
        return toolCallStreamGen("failTool", "tc-abort", '{"x":1}');
      },
      toolCall: async (_request: ToolRequest): Promise<ToolResponse> => {
        // Simulate the tool observing the user's cancellation and throwing.
        controller.abort();
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
      tools: [toolDesc("failTool")],
    };

    const events = await collect(
      runTurn({ callHandlers: handlers, messages: [], signal: controller.signal }),
    );

    // Exactly ONE model call — the runner must not synthesize an error
    // result and re-prompt after the user cancelled.
    expect(modelCallRequests).toHaveLength(1);

    // Final stop reason is interrupted, not error / completed.
    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("interrupted");
    }
  });

  test("#1742: tool execution error feeds synthetic tool_result + re-prompts model", async () => {
    // Regression for #1742: a throw from a tool call (or a wrapping
    // security/permissions middleware) used to transition the turn to
    // "error", killing the loop without letting the model explain what
    // happened. Result: users saw a silent empty reply.
    //
    // New contract: the error is fed back as a synthetic tool_result and
    // the model gets a follow-up turn to react. This test verifies both
    // the tool_result event AND that the model was called a second time.
    const modelCallRequests: ModelRequest[] = [];
    // let justified: mutable counter so the mock cycles through streams
    let streamCallIndex = 0;
    const streams: Array<() => AsyncIterable<ModelChunk>> = [
      createToolCallStream("failTool", "tc-err", '{"x":1}'),
      createTextStream("Sorry, that command can't run here."),
    ];
    const handlers: ComposedCallHandlers = {
      modelCall: async (): Promise<ModelResponse> => DONE_RESPONSE,
      modelStream: (request: ModelRequest): AsyncIterable<ModelChunk> => {
        modelCallRequests.push(request);
        const factory = streams[streamCallIndex];
        if (factory === undefined) {
          throw new Error(`unexpected model call #${streamCallIndex}`);
        }
        streamCallIndex += 1;
        return factory();
      },
      toolCall: async (_request: ToolRequest): Promise<ToolResponse> => {
        throw new Error("Tool blocked by security guard");
      },
      tools: [toolDesc("failTool")],
    };

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    // Model was called twice: once to emit the tool_use, once after the
    // synthetic error result was fed back.
    expect(modelCallRequests).toHaveLength(2);

    // A synthetic tool_result was emitted for the failing call.
    const toolResult = events.find((e) => e.kind === "tool_result") as
      | { readonly kind: "tool_result"; readonly callId: string; readonly output: unknown }
      | undefined;
    expect(toolResult).toBeDefined();
    expect(toolResult?.callId).toBe("tc-err");
    expect(toolResult?.output).toMatchObject({
      error: expect.stringContaining("Tool blocked by security guard") as unknown as string,
      code: "TOOL_EXECUTION_ERROR",
    });

    // The second model call saw the blocked tool_result in its transcript
    // — i.e. the tool result made it into the next model input.
    const secondRequest = modelCallRequests[1];
    const secondMessages = (secondRequest?.messages ?? []) as readonly {
      readonly senderId: string;
      readonly content: readonly { readonly kind: string; readonly text?: string }[];
    }[];
    const toolMsg = secondMessages.find((m) => m.senderId === "tool");
    expect(toolMsg).toBeDefined();

    // Turn ends with a real assistant text reply, not silent failure.
    const textDelta = events.find(
      (e) =>
        e.kind === "text_delta" && (e as { readonly delta: string }).delta.includes("can't run"),
    );
    expect(textDelta).toBeDefined();
  });

  test("usage metrics accumulate across turns", async () => {
    const handlers = createMockHandlers({
      modelStreams: [createToolCallStream("tool1", "tc-1", '{"a":1}'), createTextStream("final")],
      tools: [toolDesc("tool1")],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    const done = events.find((e) => e.kind === "done");
    if (done?.kind === "done") {
      // Each DONE_RESPONSE has inputTokens: 10, outputTokens: 5
      // Two model calls → 20 input, 10 output
      expect(done.output.metrics.inputTokens).toBe(20);
      expect(done.output.metrics.outputTokens).toBe(10);
      expect(done.output.metrics.totalTokens).toBe(30);
    }
  });

  test("malformed tool call args fails closed instead of executing", async () => {
    // Stream with tool call that has invalid JSON args
    async function* malformedToolStream(): AsyncIterable<ModelChunk> {
      yield { kind: "tool_call_start", toolName: "readFile", callId: callId("tc-bad") };
      yield { kind: "tool_call_delta", callId: callId("tc-bad"), delta: "{invalid json" };
      yield { kind: "tool_call_end", callId: callId("tc-bad") };
      yield { kind: "done", response: DONE_RESPONSE };
    }

    const toolCalls: string[] = [];
    const handlers = createMockHandlers({
      modelStreams: [() => malformedToolStream()],
      toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
        toolCalls.push(request.toolId);
        return { output: "should-not-run" };
      },
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    // Tool must NOT have been called
    expect(toolCalls).toEqual([]);

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("error");
    }
  });

  test("tool results are passed as messages to next model call", async () => {
    const receivedRequests: ModelRequest[] = [];

    // let justified: mutable call counter for cycling through responses
    let modelCallIndex = 0;
    const handlers: ComposedCallHandlers = {
      modelCall: async (_request: ModelRequest): Promise<ModelResponse> => DONE_RESPONSE,
      modelStream: (request: ModelRequest): AsyncIterable<ModelChunk> => {
        receivedRequests.push(request);
        const index = modelCallIndex;
        modelCallIndex += 1;
        if (index === 0) {
          return toolCallStreamGen("readFile", "tc-1", '{"path":"/foo"}');
        }
        return textStream("done");
      },
      toolCall: async (_request: ToolRequest): Promise<ToolResponse> => ({
        output: "file-content-here",
      }),
      tools: [toolDesc("readFile")],
    };

    await collect(runTurn({ callHandlers: handlers, messages: [] }));

    // Second model call should have tool result messages
    expect(receivedRequests.length).toBe(2);
    const secondRequest = receivedRequests[1];
    expect(secondRequest).toBeDefined();
    if (secondRequest !== undefined) {
      // Tool results encoded as messages with senderId "tool:<name>"
      const toolMessages = secondRequest.messages.filter((m) => m.senderId === "tool");
      expect(toolMessages.length).toBe(1);
      const toolMsg = toolMessages[0];
      if (toolMsg !== undefined) {
        expect(toolMsg.senderId).toBe("tool");
        const textBlock = toolMsg.content[0];
        if (textBlock?.kind === "text") {
          const parsed: unknown = JSON.parse(textBlock.text);
          expect(parsed).toMatchObject({ callId: "tc-1", output: "file-content-here" });
        }
      }
    }
  });

  test("truncated stream without terminal chunk produces error done", async () => {
    // Stream that yields text but never emits done/error
    async function* truncatedStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "partial response" };
      // No done/error — stream just ends
    }

    const handlers = createMockHandlers({
      modelStreams: [() => truncatedStream()],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("error");
    }
  });

  test("done.output.content contains accumulated text", async () => {
    const handlers = createMockHandlers({
      modelStreams: [createTextStream("hello world")],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.content.length).toBe(1);
      const block = done.output.content[0];
      if (block?.kind === "text") {
        expect(block.text).toBe("hello world");
      }
    }
  });

  test("done.output.content is empty when no text emitted", async () => {
    // Stream with only tool calls, no text
    const handlers = createMockHandlers({
      modelStreams: [createToolCallStream("tool1", "tc-1", '{"a":1}'), createTextStream("")],
      tools: [toolDesc("tool1")],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      // The second turn emits empty text, so content should be empty
      expect(done.output.content.length).toBe(0);
    }
  });

  test("transcript accumulates across turns for model context", async () => {
    const receivedRequests: ModelRequest[] = [];

    // let justified: mutable call counter for cycling through responses
    let modelCallIndex = 0;
    const handlers: ComposedCallHandlers = {
      modelCall: async (_request: ModelRequest): Promise<ModelResponse> => DONE_RESPONSE,
      modelStream: (request: ModelRequest): AsyncIterable<ModelChunk> => {
        receivedRequests.push(request);
        const index = modelCallIndex;
        modelCallIndex += 1;
        if (index === 0) {
          return toolCallStreamGen("readFile", "tc-1", '{"path":"/foo"}');
        }
        return textStream("final answer");
      },
      toolCall: async (_request: ToolRequest): Promise<ToolResponse> => ({
        output: "file-content",
      }),
      tools: [toolDesc("readFile")],
    };

    await collect(runTurn({ callHandlers: handlers, messages: [] }));

    // Second model call should include assistant message + tool result
    expect(receivedRequests.length).toBe(2);
    const secondRequest = receivedRequests[1];
    expect(secondRequest).toBeDefined();
    if (secondRequest !== undefined) {
      // Should have assistant turn (with tool call intent) + tool result
      const assistantMsgs = secondRequest.messages.filter((m) => m.senderId === "assistant");
      const toolMsgs = secondRequest.messages.filter((m) => m.senderId === "tool");
      expect(assistantMsgs.length).toBe(1);
      expect(toolMsgs.length).toBe(1);
    }
  });

  test("tool calls execute sequentially preserving order", async () => {
    const executionOrder: string[] = [];

    async function* multiToolStream(): AsyncIterable<ModelChunk> {
      yield { kind: "tool_call_start", toolName: "first", callId: callId("tc-1") };
      yield { kind: "tool_call_delta", callId: callId("tc-1"), delta: '{"n":1}' };
      yield { kind: "tool_call_end", callId: callId("tc-1") };
      yield { kind: "tool_call_start", toolName: "second", callId: callId("tc-2") };
      yield { kind: "tool_call_delta", callId: callId("tc-2"), delta: '{"n":2}' };
      yield { kind: "tool_call_end", callId: callId("tc-2") };
      yield { kind: "done", response: DONE_RESPONSE };
    }

    const handlers = createMockHandlers({
      modelStreams: [() => multiToolStream(), createTextStream("done")],
      toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
        executionOrder.push(request.toolId);
        return { output: `result-${request.toolId}` };
      },
      tools: [toolDesc("first"), toolDesc("second")],
    });

    await collect(runTurn({ callHandlers: handlers, messages: [] }));

    // Must execute in model-emitted order, not interleaved
    expect(executionOrder).toEqual(["first", "second"]);
  });

  test("done.output.content contains only terminal turn text, not all turns", async () => {
    // Turn 0 emits "thinking..." then tool call, turn 1 emits "final answer"
    async function* thinkingThenToolStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "thinking..." };
      yield { kind: "tool_call_start", toolName: "search", callId: callId("tc-1") };
      yield { kind: "tool_call_delta", callId: callId("tc-1"), delta: '{"q":"x"}' };
      yield { kind: "tool_call_end", callId: callId("tc-1") };
      yield { kind: "done", response: DONE_RESPONSE };
    }

    const handlers = createMockHandlers({
      modelStreams: [() => thinkingThenToolStream(), createTextStream("final answer")],
      tools: [toolDesc("search")],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      // Should only contain the terminal turn's text, not "thinking...final answer"
      expect(done.output.content.length).toBe(1);
      const block = done.output.content[0];
      if (block?.kind === "text") {
        expect(block.text).toBe("final answer");
      }
    }
  });

  test("non-JSON-serializable tool output does not crash the runner", async () => {
    const handlers = createMockHandlers({
      modelStreams: [createToolCallStream("tool1", "tc-1", '{"a":1}'), createTextStream("ok")],
      toolCall: async (_request: ToolRequest): Promise<ToolResponse> => {
        // BigInt is not JSON-serializable
        return { output: BigInt(42) };
      },
      tools: [toolDesc("tool1")],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    // Should complete without crashing — safe serializer falls back to String()
    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("completed");
    }
  });

  test("undeclared tool calls are rejected before execution", async () => {
    const toolCalls: string[] = [];
    const handlers: ComposedCallHandlers = {
      modelCall: async (_request: ModelRequest): Promise<ModelResponse> => DONE_RESPONSE,
      modelStream: (_request: ModelRequest): AsyncIterable<ModelChunk> => {
        return toolCallStreamGen("secretTool", "tc-1", '{"x":1}');
      },
      toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
        toolCalls.push(request.toolId);
        return { output: "should-not-run" };
      },
      // Only "readFile" is declared — "secretTool" is not
      tools: [{ name: "readFile", description: "read a file", inputSchema: {} }],
    };

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    // Tool must NOT have been called
    expect(toolCalls).toEqual([]);

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("error");
    }
  });

  test("abort during tool execution stops remaining tools", async () => {
    const controller = new AbortController();
    const executedTools: string[] = [];

    async function* twoToolStream(): AsyncIterable<ModelChunk> {
      yield { kind: "tool_call_start", toolName: "first", callId: callId("tc-1") };
      yield { kind: "tool_call_delta", callId: callId("tc-1"), delta: '{"n":1}' };
      yield { kind: "tool_call_end", callId: callId("tc-1") };
      yield { kind: "tool_call_start", toolName: "second", callId: callId("tc-2") };
      yield { kind: "tool_call_delta", callId: callId("tc-2"), delta: '{"n":2}' };
      yield { kind: "tool_call_end", callId: callId("tc-2") };
      yield { kind: "done", response: DONE_RESPONSE };
    }

    const handlers: ComposedCallHandlers = {
      modelCall: async (_request: ModelRequest): Promise<ModelResponse> => DONE_RESPONSE,
      modelStream: (_request: ModelRequest): AsyncIterable<ModelChunk> => twoToolStream(),
      toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
        executedTools.push(request.toolId);
        // Abort after first tool completes
        if (request.toolId === "first") {
          controller.abort();
        }
        return { output: `result-${request.toolId}` };
      },
      tools: [
        { name: "first", description: "", inputSchema: {} },
        { name: "second", description: "", inputSchema: {} },
      ],
    };

    const events = await collect(
      runTurn({ callHandlers: handlers, messages: [], signal: controller.signal }),
    );

    // Only the first tool should have executed
    expect(executedTools).toEqual(["first"]);

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("interrupted");
    }
  });

  test("pre-aborted signal produces interrupted done without model call", async () => {
    const controller = new AbortController();
    controller.abort();

    // let justified: mutable flag to detect if model was called
    let modelCalled = false;
    const handlers = createMockHandlers({
      modelStreams: [
        () => {
          modelCalled = true;
          return textStream("should not run");
        },
      ],
    });

    const events = await collect(
      runTurn({ callHandlers: handlers, messages: [], signal: controller.signal }),
    );

    expect(modelCalled).toBe(false);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["done"]);
    const done = events[0];
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("interrupted");
      expect(done.output.metrics.turns).toBe(0);
    }
  });

  test("maxTurns 0 produces max_turns done without model call", async () => {
    // let justified: mutable flag to detect if model was called
    let modelCalled = false;
    const handlers = createMockHandlers({
      modelStreams: [
        () => {
          modelCalled = true;
          return textStream("should not run");
        },
      ],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [], maxTurns: 0 }));

    expect(modelCalled).toBe(false);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["done"]);
    const done = events[0];
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("max_turns");
      expect(done.output.metrics.turns).toBe(0);
    }
  });

  test("tool args missing required fields are rejected before execution", async () => {
    const toolCalls: string[] = [];
    const handlers: ComposedCallHandlers = {
      modelCall: async (_request: ModelRequest): Promise<ModelResponse> => DONE_RESPONSE,
      modelStream: (_request: ModelRequest): AsyncIterable<ModelChunk> => {
        // Tool call with args missing the required "path" field
        return toolCallStreamGen("readFile", "tc-1", '{"encoding":"utf8"}');
      },
      toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
        toolCalls.push(request.toolId);
        return { output: "should-not-run" };
      },
      tools: [
        {
          name: "readFile",
          description: "read a file",
          inputSchema: {
            type: "object",
            required: ["path"],
            properties: { path: { type: "string" } },
          },
        },
      ],
    };

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    expect(toolCalls).toEqual([]);
    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("error");
      // Error metadata should identify schema validation as the source
      expect(done.output.metadata).toBeDefined();
      if (done.output.metadata !== undefined) {
        expect(done.output.metadata.source).toBe("schema_validation");
      }
    }
  });

  test("tool args with wrong type are rejected before execution", async () => {
    const toolCalls: string[] = [];
    const handlers: ComposedCallHandlers = {
      modelCall: async (_request: ModelRequest): Promise<ModelResponse> => DONE_RESPONSE,
      modelStream: (_request: ModelRequest): AsyncIterable<ModelChunk> => {
        // path should be string but model sent number
        return toolCallStreamGen("readFile", "tc-1", '{"path":123}');
      },
      toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
        toolCalls.push(request.toolId);
        return { output: "should-not-run" };
      },
      tools: [
        {
          name: "readFile",
          description: "read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
    };

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    expect(toolCalls).toEqual([]);
    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("error");
    }
  });

  test("error metadata is included in done event for model stream errors", async () => {
    async function* errorStream(): AsyncIterable<ModelChunk> {
      yield { kind: "error", message: "rate limited" };
    }

    const handlers = createMockHandlers({
      modelStreams: [() => errorStream()],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("error");
      expect(done.output.metadata).toBeDefined();
      if (done.output.metadata !== undefined) {
        expect(done.output.metadata.source).toBe("model_stream");
      }
    }
  });

  test("abort after tool execution still records the tool result", async () => {
    const controller = new AbortController();

    async function* singleToolStream(): AsyncIterable<ModelChunk> {
      yield { kind: "tool_call_start", toolName: "write", callId: callId("tc-1") };
      yield { kind: "tool_call_delta", callId: callId("tc-1"), delta: '{"data":"x"}' };
      yield { kind: "tool_call_end", callId: callId("tc-1") };
      yield { kind: "done", response: DONE_RESPONSE };
    }

    const transcript: ModelRequest[] = [];
    const handlers: ComposedCallHandlers = {
      modelCall: async (_request: ModelRequest): Promise<ModelResponse> => DONE_RESPONSE,
      modelStream: (request: ModelRequest): AsyncIterable<ModelChunk> => {
        transcript.push(request);
        return singleToolStream();
      },
      toolCall: async (_request: ToolRequest): Promise<ToolResponse> => {
        // Abort after tool completes
        controller.abort();
        return { output: "written" };
      },
      tools: [{ name: "write", description: "", inputSchema: {} }],
    };

    const events = await collect(
      runTurn({ callHandlers: handlers, messages: [], signal: controller.signal }),
    );

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("interrupted");
    }

    // The key assertion: despite abort, the tool result must be in the event stream
    // (turn_end was emitted, meaning the transcript was updated before abort)
    const turnEnd = events.find((e) => e.kind === "turn_end");
    expect(turnEnd).toBeDefined();
  });

  test("failed terminal turn reports its own text, not previous turn", async () => {
    async function* textThenToolStream(): AsyncIterable<ModelChunk> {
      yield { kind: "tool_call_start", toolName: "tool1", callId: callId("tc-1") };
      yield { kind: "tool_call_delta", callId: callId("tc-1"), delta: '{"a":1}' };
      yield { kind: "tool_call_end", callId: callId("tc-1") };
      yield { kind: "done", response: DONE_RESPONSE };
    }

    async function* failingStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "partial from failing turn" };
      throw new Error("connection lost");
    }

    const handlers = createMockHandlers({
      modelStreams: [() => textThenToolStream(), () => failingStream()],
      tools: [toolDesc("tool1")],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("error");
      // Should contain the failing turn's text, not empty or previous turn's
      expect(done.output.content.length).toBe(1);
      const block = done.output.content[0];
      if (block?.kind === "text") {
        expect(block.text).toBe("partial from failing turn");
      }
    }
  });

  test("partial usage is preserved when stream is aborted before done", async () => {
    const controller = new AbortController();

    async function* streamWithUsage(): AsyncIterable<ModelChunk> {
      yield { kind: "usage", inputTokens: 15, outputTokens: 8 };
      yield { kind: "text_delta", delta: "partial" };
      controller.abort();
      yield { kind: "text_delta", delta: " more" };
      yield { kind: "done", response: DONE_RESPONSE };
    }

    const handlers = createMockHandlers({
      modelStreams: [() => streamWithUsage()],
    });

    const events = await collect(
      runTurn({ callHandlers: handlers, messages: [], signal: controller.signal }),
    );

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("interrupted");
      // Partial usage from before abort should be preserved
      expect(done.output.metrics.inputTokens).toBe(15);
      expect(done.output.metrics.outputTokens).toBe(8);
    }
  });

  test("partial usage is preserved when stream throws", async () => {
    async function* streamWithUsageThenError(): AsyncIterable<ModelChunk> {
      yield { kind: "usage", inputTokens: 20, outputTokens: 10 };
      yield { kind: "text_delta", delta: "partial" };
      throw new Error("connection lost");
    }

    const handlers = createMockHandlers({
      modelStreams: [() => streamWithUsageThenError()],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("error");
      expect(done.output.metrics.inputTokens).toBe(20);
      expect(done.output.metrics.outputTokens).toBe(10);
    }
  });

  test("model error with usage does not double-count tokens", async () => {
    async function* streamWithUsageThenModelError(): AsyncIterable<ModelChunk> {
      yield { kind: "usage", inputTokens: 15, outputTokens: 8 };
      yield { kind: "text_delta", delta: "partial" };
      // Error chunk with authoritative usage — should NOT be added on top
      yield { kind: "error", message: "rate limited", usage: { inputTokens: 15, outputTokens: 8 } };
    }

    const handlers = createMockHandlers({
      modelStreams: [() => streamWithUsageThenModelError()],
    });

    const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("error");
      // Must be 15/8, NOT 30/16 (double-counted)
      expect(done.output.metrics.inputTokens).toBe(15);
      expect(done.output.metrics.outputTokens).toBe(8);
      expect(done.output.metrics.totalTokens).toBe(23);
    }
  });

  // -----------------------------------------------------------------------
  // Stop gate (turn.stop)
  // -----------------------------------------------------------------------

  describe("stop gate", () => {
    test("blocks completion and re-prompts when stopGate returns block", async () => {
      // let justified: mutable gate call counter
      let gateCallCount = 0;
      const handlers = createMockHandlers({
        // First call: model completes (blocked by gate)
        // Second call: model completes (gate allows)
        modelStreams: [createTextStream("first attempt"), createTextStream("second attempt")],
      });

      const events = await collect(
        runTurn({
          callHandlers: handlers,
          messages: [],
          stopGate: async (_turnIndex: number) => {
            gateCallCount++;
            if (gateCallCount === 1) {
              return { kind: "block", reason: "tests not passing", blockedBy: "test-gate" };
            }
            return { kind: "continue" };
          },
        }),
      );

      // Gate was called twice (once blocked, once allowed)
      expect(gateCallCount).toBe(2);

      // Should have two turn cycles + final done
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("turn_start");
      expect(kinds).toContain("turn_end");

      const done = events.find((e) => e.kind === "done");
      expect(done).toBeDefined();
      if (done?.kind === "done") {
        expect(done.output.stopReason).toBe("completed");
        expect(done.output.metadata?.stopRetryCount).toBe(1);
      }
    });

    test("respects maxStopRetries limit", async () => {
      // let justified: mutable gate call counter
      let gateCallCount = 0;
      const handlers = createMockHandlers({
        // 3 model calls: initial + 2 retries, then forced completion
        modelStreams: [
          createTextStream("attempt 1"),
          createTextStream("attempt 2"),
          createTextStream("attempt 3"),
        ],
      });

      const events = await collect(
        runTurn({
          callHandlers: handlers,
          messages: [],
          maxStopRetries: 2,
          stopGate: async (_turnIndex: number) => {
            gateCallCount++;
            return { kind: "block", reason: "always block", blockedBy: "test-gate" };
          },
        }),
      );

      // Gate called exactly maxStopRetries times (2), then completion forced
      expect(gateCallCount).toBe(2);

      const done = events.find((e) => e.kind === "done");
      expect(done).toBeDefined();
      if (done?.kind === "done") {
        expect(done.output.stopReason).toBe("completed");
        expect(done.output.metadata?.stopRetryCount).toBe(2);
      }
    });

    test("does not call stopGate when no gate is provided", async () => {
      const handlers = createMockHandlers({
        modelStreams: [createTextStream("hello")],
      });

      const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

      const done = events.find((e) => e.kind === "done");
      expect(done).toBeDefined();
      if (done?.kind === "done") {
        expect(done.output.stopReason).toBe("completed");
        expect(done.output.metadata).toBeUndefined();
      }
    });

    test("does not call stopGate on error completion", async () => {
      // let justified: mutable flag to track gate calls
      let gateCalled = false;

      // Stream that ends without a terminal done/error chunk (truncated)
      async function* truncatedStream(): AsyncIterable<ModelChunk> {
        yield { kind: "text_delta", delta: "partial" };
        // No done event — simulates truncated stream
      }

      const handlers = createMockHandlers({
        modelStreams: [() => truncatedStream()],
      });

      await collect(
        runTurn({
          callHandlers: handlers,
          messages: [],
          stopGate: async (_turnIndex: number) => {
            gateCalled = true;
            return { kind: "block", reason: "should not be called", blockedBy: "test-gate" };
          },
        }),
      );

      expect(gateCalled).toBe(false);
    });

    test("stopGate continue allows normal completion", async () => {
      // let justified: mutable gate call counter
      let gateCallCount = 0;
      const handlers = createMockHandlers({
        modelStreams: [createTextStream("done")],
      });

      const events = await collect(
        runTurn({
          callHandlers: handlers,
          messages: [],
          stopGate: async (_turnIndex: number) => {
            gateCallCount++;
            return { kind: "continue" };
          },
        }),
      );

      expect(gateCallCount).toBe(1);

      const done = events.find((e) => e.kind === "done");
      expect(done).toBeDefined();
      if (done?.kind === "done") {
        expect(done.output.stopReason).toBe("completed");
      }
    });
  });

  describe("within-turn dedup", () => {
    test("duplicate tool calls within a turn are deduped", async () => {
      const callCount = { value: 0 };

      async function* dupToolStream(): AsyncIterable<ModelChunk> {
        // Two identical tool calls: same name, same args, different callId
        yield { kind: "tool_call_start", toolName: "task_create", callId: callId("tc-1") };
        yield { kind: "tool_call_delta", callId: callId("tc-1"), delta: '{"subject":"Fix auth"}' };
        yield { kind: "tool_call_end", callId: callId("tc-1") };
        yield { kind: "tool_call_start", toolName: "task_create", callId: callId("tc-2") };
        yield { kind: "tool_call_delta", callId: callId("tc-2"), delta: '{"subject":"Fix auth"}' };
        yield { kind: "tool_call_end", callId: callId("tc-2") };
        yield { kind: "done", response: DONE_RESPONSE };
      }

      const handlers = createMockHandlers({
        modelStreams: [() => dupToolStream(), createTextStream("done")],
        toolCall: async (_request: ToolRequest): Promise<ToolResponse> => {
          callCount.value += 1;
          return { output: "created" };
        },
        tools: [toolDesc("task_create")],
      });

      const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

      // Tool handler should be called exactly once — duplicate skipped
      expect(callCount.value).toBe(1);

      // Should emit dedup_skipped custom event
      const dedupEvent = events.find((e) => e.kind === "custom" && e.type === "dedup_skipped");
      expect(dedupEvent).toBeDefined();
      if (dedupEvent?.kind === "custom") {
        const data = dedupEvent.data as {
          skipped: ReadonlyArray<{ toolName: string; callId: string }>;
        };
        expect(data.skipped).toHaveLength(1);
        expect(data.skipped[0]?.toolName).toBe("task_create");
        expect(data.skipped[0]?.callId).toBe("tc-2");
      }

      // Should complete successfully
      const done = events.find((e) => e.kind === "done");
      expect(done).toBeDefined();
      if (done?.kind === "done") {
        expect(done.output.stopReason).toBe("completed");
      }
    });

    test("different args are not deduped", async () => {
      const callCount = { value: 0 };

      async function* diffArgsStream(): AsyncIterable<ModelChunk> {
        yield { kind: "tool_call_start", toolName: "task_create", callId: callId("tc-1") };
        yield { kind: "tool_call_delta", callId: callId("tc-1"), delta: '{"subject":"Task A"}' };
        yield { kind: "tool_call_end", callId: callId("tc-1") };
        yield { kind: "tool_call_start", toolName: "task_create", callId: callId("tc-2") };
        yield { kind: "tool_call_delta", callId: callId("tc-2"), delta: '{"subject":"Task B"}' };
        yield { kind: "tool_call_end", callId: callId("tc-2") };
        yield { kind: "done", response: DONE_RESPONSE };
      }

      const handlers = createMockHandlers({
        modelStreams: [() => diffArgsStream(), createTextStream("done")],
        toolCall: async (_request: ToolRequest): Promise<ToolResponse> => {
          callCount.value += 1;
          return { output: "created" };
        },
        tools: [toolDesc("task_create")],
      });

      const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

      // Both should execute — different args
      expect(callCount.value).toBe(2);

      // No dedup event
      const dedupEvent = events.find((e) => e.kind === "custom" && e.type === "dedup_skipped");
      expect(dedupEvent).toBeUndefined();
    });

    test("different tool names with same args are not deduped", async () => {
      const callCount = { value: 0 };

      async function* diffToolsStream(): AsyncIterable<ModelChunk> {
        yield { kind: "tool_call_start", toolName: "task_create", callId: callId("tc-1") };
        yield { kind: "tool_call_delta", callId: callId("tc-1"), delta: '{"subject":"Same"}' };
        yield { kind: "tool_call_end", callId: callId("tc-1") };
        yield { kind: "tool_call_start", toolName: "task_update", callId: callId("tc-2") };
        yield { kind: "tool_call_delta", callId: callId("tc-2"), delta: '{"subject":"Same"}' };
        yield { kind: "tool_call_end", callId: callId("tc-2") };
        yield { kind: "done", response: DONE_RESPONSE };
      }

      const handlers = createMockHandlers({
        modelStreams: [() => diffToolsStream(), createTextStream("done")],
        toolCall: async (_request: ToolRequest): Promise<ToolResponse> => {
          callCount.value += 1;
          return { output: "ok" };
        },
        tools: [toolDesc("task_create"), toolDesc("task_update")],
      });

      const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

      // Both should execute — different tool names
      expect(callCount.value).toBe(2);

      // No dedup event
      const dedupEvent = events.find((e) => e.kind === "custom" && e.type === "dedup_skipped");
      expect(dedupEvent).toBeUndefined();
    });

    test("semantically identical args with different key order are deduped", async () => {
      const callCount = { value: 0 };

      async function* reorderedKeysStream(): AsyncIterable<ModelChunk> {
        // Same args but different JSON key order
        yield { kind: "tool_call_start", toolName: "task_create", callId: callId("tc-1") };
        yield {
          kind: "tool_call_delta",
          callId: callId("tc-1"),
          delta: '{"subject":"X","desc":"Y"}',
        };
        yield { kind: "tool_call_end", callId: callId("tc-1") };
        yield { kind: "tool_call_start", toolName: "task_create", callId: callId("tc-2") };
        yield {
          kind: "tool_call_delta",
          callId: callId("tc-2"),
          delta: '{"desc":"Y","subject":"X"}',
        };
        yield { kind: "tool_call_end", callId: callId("tc-2") };
        yield { kind: "done", response: DONE_RESPONSE };
      }

      const handlers = createMockHandlers({
        modelStreams: [() => reorderedKeysStream(), createTextStream("done")],
        toolCall: async (_request: ToolRequest): Promise<ToolResponse> => {
          callCount.value += 1;
          return { output: "created" };
        },
        tools: [toolDesc("task_create")],
      });

      const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

      // Should dedup despite different key order
      expect(callCount.value).toBe(1);

      const dedupEvent = events.find((e) => e.kind === "custom" && e.type === "dedup_skipped");
      expect(dedupEvent).toBeDefined();
    });

    test("nested args with different values are not deduped", async () => {
      const callCount = { value: 0 };

      async function* nestedArgsStream(): AsyncIterable<ModelChunk> {
        // Same top-level keys but different nested values
        yield { kind: "tool_call_start", toolName: "search", callId: callId("tc-1") };
        yield {
          kind: "tool_call_delta",
          callId: callId("tc-1"),
          delta: '{"filter":{"status":"open"}}',
        };
        yield { kind: "tool_call_end", callId: callId("tc-1") };
        yield { kind: "tool_call_start", toolName: "search", callId: callId("tc-2") };
        yield {
          kind: "tool_call_delta",
          callId: callId("tc-2"),
          delta: '{"filter":{"status":"closed"}}',
        };
        yield { kind: "tool_call_end", callId: callId("tc-2") };
        yield { kind: "done", response: DONE_RESPONSE };
      }

      const handlers = createMockHandlers({
        modelStreams: [() => nestedArgsStream(), createTextStream("done")],
        toolCall: async (_request: ToolRequest): Promise<ToolResponse> => {
          callCount.value += 1;
          return { output: "results" };
        },
        tools: [toolDesc("search")],
      });

      const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

      // Both should execute — different nested values
      expect(callCount.value).toBe(2);

      const dedupEvent = events.find((e) => e.kind === "custom" && e.type === "dedup_skipped");
      expect(dedupEvent).toBeUndefined();
    });

    test("skipped duplicate has synthetic tool result in transcript", async () => {
      const receivedRequests: ModelRequest[] = [];
      // let justified: mutable call counter for cycling through responses
      let modelCallIndex = 0;

      const handlers: ComposedCallHandlers = {
        modelCall: async (_request: ModelRequest): Promise<ModelResponse> => DONE_RESPONSE,
        modelStream: (request: ModelRequest): AsyncIterable<ModelChunk> => {
          receivedRequests.push(request);
          const index = modelCallIndex;
          modelCallIndex += 1;
          if (index === 0) {
            return (async function* (): AsyncIterable<ModelChunk> {
              yield { kind: "tool_call_start", toolName: "task_create", callId: callId("tc-1") };
              yield { kind: "tool_call_delta", callId: callId("tc-1"), delta: '{"s":"X"}' };
              yield { kind: "tool_call_end", callId: callId("tc-1") };
              yield { kind: "tool_call_start", toolName: "task_create", callId: callId("tc-2") };
              yield { kind: "tool_call_delta", callId: callId("tc-2"), delta: '{"s":"X"}' };
              yield { kind: "tool_call_end", callId: callId("tc-2") };
              yield { kind: "done", response: DONE_RESPONSE };
            })();
          }
          return textStream("done");
        },
        toolCall: async (_request: ToolRequest): Promise<ToolResponse> => ({
          output: "created",
        }),
        tools: [toolDesc("task_create")],
      };

      await collect(runTurn({ callHandlers: handlers, messages: [] }));

      // Second model call transcript should have both assistant intents and
      // two tool results (real + replicated) for callId pairing
      expect(receivedRequests.length).toBe(2);
      const secondRequest = receivedRequests[1];
      expect(secondRequest).toBeDefined();
      if (secondRequest !== undefined) {
        const assistantMsgs = secondRequest.messages.filter((m) => m.senderId === "assistant");
        const toolMsgs = secondRequest.messages.filter((m) => m.senderId === "tool");
        // 1 assistant message with both tool call intents in metadata.toolCalls
        expect(assistantMsgs.length).toBe(1);
        // 2 tool results (real execution + replicated real output)
        expect(toolMsgs.length).toBe(2);
        // Both tool results should contain the real output, not a placeholder
        for (const msg of toolMsgs) {
          const text = msg.content[0];
          if (text?.kind === "text") {
            expect(text.text).toContain('"created"');
          }
        }
      }
    });
  });

  describe("doom loop detection", () => {
    test("detects doom loop after threshold consecutive identical tool calls", async () => {
      // 3 turns of identical readFile calls, then model responds with text after intervention
      const handlers = createMockHandlers({
        modelStreams: [
          createToolCallStream("readFile", "tc-1", '{"path":"/foo"}'),
          createToolCallStream("readFile", "tc-2", '{"path":"/foo"}'),
          createToolCallStream("readFile", "tc-3", '{"path":"/foo"}'),
          // After doom loop intervention, model responds with text
          createTextStream("I will try a different approach"),
        ],
        tools: [toolDesc("readFile")],
      });

      const events = await collect(
        runTurn({
          callHandlers: handlers,
          messages: [],
          doomLoopThreshold: 3,
        }),
      );

      // Should have a doom_loop_detected custom event
      const doomEvent = events.find(
        (e) => e.kind === "custom" && (e as { type: string }).type === "doom_loop_detected",
      );
      expect(doomEvent).toBeDefined();
      if (doomEvent?.kind === "custom") {
        const data = doomEvent.data as { toolNames: readonly string[]; consecutiveTurns: number };
        expect(data.toolNames).toEqual(["readFile"]);
        expect(data.consecutiveTurns).toBe(3);
      }

      // Should complete successfully after re-prompt
      const done = events.find((e) => e.kind === "done");
      expect(done).toBeDefined();
      if (done?.kind === "done") {
        expect(done.output.stopReason).toBe("completed");
      }
    });

    test("does not fire below threshold", async () => {
      // 2 identical calls with threshold=3 — no doom loop
      const toolCalls: string[] = [];
      const handlers = createMockHandlers({
        modelStreams: [
          createToolCallStream("readFile", "tc-1", '{"path":"/foo"}'),
          createToolCallStream("readFile", "tc-2", '{"path":"/foo"}'),
          createTextStream("done"),
        ],
        toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
          toolCalls.push(request.toolId);
          return { output: "file-content" };
        },
        tools: [toolDesc("readFile")],
      });

      const events = await collect(
        runTurn({
          callHandlers: handlers,
          messages: [],
          doomLoopThreshold: 3,
        }),
      );

      // No doom loop event
      const doomEvent = events.find(
        (e) => e.kind === "custom" && (e as { type: string }).type === "doom_loop_detected",
      );
      expect(doomEvent).toBeUndefined();

      // Both tool calls should have executed
      expect(toolCalls).toEqual(["readFile", "readFile"]);
    });

    test("different args reset the streak", async () => {
      const toolCalls: string[] = [];
      const handlers = createMockHandlers({
        modelStreams: [
          createToolCallStream("readFile", "tc-1", '{"path":"/foo"}'),
          createToolCallStream("readFile", "tc-2", '{"path":"/bar"}'),
          createToolCallStream("readFile", "tc-3", '{"path":"/foo"}'),
          createTextStream("done"),
        ],
        toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
          toolCalls.push(request.toolId);
          return { output: "content" };
        },
        tools: [toolDesc("readFile")],
      });

      const events = await collect(
        runTurn({
          callHandlers: handlers,
          messages: [],
          doomLoopThreshold: 3,
        }),
      );

      // No doom loop — streak was broken by different args
      const doomEvent = events.find(
        (e) => e.kind === "custom" && (e as { type: string }).type === "doom_loop_detected",
      );
      expect(doomEvent).toBeUndefined();

      // All 3 tool calls executed
      expect(toolCalls.length).toBe(3);
    });

    test("text-only turn resets streak", async () => {
      const toolCalls: string[] = [];
      const handlers = createMockHandlers({
        modelStreams: [
          createToolCallStream("readFile", "tc-1", '{"path":"/foo"}'),
          createToolCallStream("readFile", "tc-2", '{"path":"/foo"}'),
          // Text-only turn breaks the streak
          createTextStream("thinking..."),
        ],
        toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
          toolCalls.push(request.toolId);
          return { output: "content" };
        },
        tools: [toolDesc("readFile")],
      });

      const events = await collect(
        runTurn({
          callHandlers: handlers,
          messages: [],
          doomLoopThreshold: 3,
          // Use stop gate to re-enter the loop after text-only turn
          stopGate: async (_turnIndex: number) => {
            return { kind: "continue" };
          },
        }),
      );

      // No doom loop event — text-only turn broke the streak
      const doomEvent = events.find(
        (e) => e.kind === "custom" && (e as { type: string }).type === "doom_loop_detected",
      );
      expect(doomEvent).toBeUndefined();

      // Both tool calls should have executed
      expect(toolCalls.length).toBe(2);
    });

    test("threshold=0 disables detection", async () => {
      const toolCalls: string[] = [];
      const handlers = createMockHandlers({
        modelStreams: [
          createToolCallStream("readFile", "tc-1", '{"path":"/foo"}'),
          createToolCallStream("readFile", "tc-2", '{"path":"/foo"}'),
          createToolCallStream("readFile", "tc-3", '{"path":"/foo"}'),
          createTextStream("done"),
        ],
        toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
          toolCalls.push(request.toolId);
          return { output: "content" };
        },
        tools: [toolDesc("readFile")],
      });

      const events = await collect(
        runTurn({
          callHandlers: handlers,
          messages: [],
          doomLoopThreshold: 0,
        }),
      );

      // No doom loop — detection disabled
      const doomEvent = events.find(
        (e) => e.kind === "custom" && (e as { type: string }).type === "doom_loop_detected",
      );
      expect(doomEvent).toBeUndefined();

      // All 3 tool calls executed
      expect(toolCalls.length).toBe(3);
    });

    test("respects maxDoomLoopInterventions cap", async () => {
      // 5 identical calls with threshold=2, maxInterventions=2
      // Turns 1-2: identical → intervention 1
      // Turn 3: identical → intervention 2 (cap reached)
      // Turn 4: identical → no intervention, tool executes
      const toolCalls: string[] = [];
      const handlers = createMockHandlers({
        modelStreams: [
          createToolCallStream("readFile", "tc-1", '{"path":"/foo"}'),
          createToolCallStream("readFile", "tc-2", '{"path":"/foo"}'),
          // After intervention 1, model tries again
          createToolCallStream("readFile", "tc-3", '{"path":"/foo"}'),
          // After intervention 2, model tries again — cap exhausted, tool executes
          createToolCallStream("readFile", "tc-4", '{"path":"/foo"}'),
          createTextStream("done"),
        ],
        toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
          toolCalls.push(request.toolId);
          return { output: "content" };
        },
        tools: [toolDesc("readFile")],
      });

      const events = await collect(
        runTurn({
          callHandlers: handlers,
          messages: [],
          doomLoopThreshold: 2,
          maxDoomLoopInterventions: 2,
        }),
      );

      // Should have exactly 2 doom loop events
      const doomEvents = events.filter(
        (e) => e.kind === "custom" && (e as { type: string }).type === "doom_loop_detected",
      );
      expect(doomEvents.length).toBe(2);

      // After cap exhausted, tool should execute
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      const done = events.find((e) => e.kind === "done");
      expect(done).toBeDefined();
      if (done?.kind === "done") {
        expect(done.output.stopReason).toBe("completed");
      }
    });

    test("doom loop interventions count against maxTurns budget", async () => {
      // maxTurns=4, doomLoopThreshold=3 — intervention uses turn 4,
      // and recovery turn gets turn 5 which is within budget.
      const handlers = createMockHandlers({
        modelStreams: [
          createToolCallStream("readFile", "tc-1", '{"path":"/foo"}'),
          createToolCallStream("readFile", "tc-2", '{"path":"/foo"}'),
          createToolCallStream("readFile", "tc-3", '{"path":"/foo"}'),
          // Recovery turn after intervention
          createTextStream("I will try something else"),
        ],
        tools: [toolDesc("readFile")],
      });

      const events = await collect(
        runTurn({
          callHandlers: handlers,
          messages: [],
          doomLoopThreshold: 3,
          maxTurns: 5,
        }),
      );

      const done = events.find((e) => e.kind === "done");
      expect(done).toBeDefined();
      if (done?.kind === "done") {
        // Should complete normally with enough budget
        expect(done.output.stopReason).toBe("completed");
      }
    });

    test("mixed turn filters repeated calls but executes new ones", async () => {
      // readFile("/foo") is repeated 3 times, but each turn also has writeFile
      // with different args. The repeated readFile should be filtered in turn 3,
      // while writeFile still executes.
      const toolCalls: string[] = [];

      async function* mixedToolStream(
        rfId: string,
        wfId: string,
        wfArgs: string,
      ): AsyncIterable<ModelChunk> {
        yield { kind: "tool_call_start", toolName: "readFile", callId: callId(rfId) };
        yield { kind: "tool_call_delta", callId: callId(rfId), delta: '{"path":"/foo"}' };
        yield { kind: "tool_call_end", callId: callId(rfId) };
        yield { kind: "tool_call_start", toolName: "writeFile", callId: callId(wfId) };
        yield { kind: "tool_call_delta", callId: callId(wfId), delta: wfArgs };
        yield { kind: "tool_call_end", callId: callId(wfId) };
        yield { kind: "done", response: DONE_RESPONSE };
      }

      const handlers = createMockHandlers({
        modelStreams: [
          () => mixedToolStream("tc-1a", "tc-1b", '{"path":"/a"}'),
          () => mixedToolStream("tc-2a", "tc-2b", '{"path":"/b"}'),
          () => mixedToolStream("tc-3a", "tc-3b", '{"path":"/c"}'),
          createTextStream("done"),
        ],
        toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
          toolCalls.push(request.toolId);
          return { output: "ok" };
        },
        tools: [toolDesc("readFile"), toolDesc("writeFile")],
      });

      const events = await collect(
        runTurn({
          callHandlers: handlers,
          messages: [],
          doomLoopThreshold: 3,
        }),
      );

      // No full doom loop event (not all calls repeated)
      const doomEvent = events.find(
        (e) => e.kind === "custom" && (e as { type: string }).type === "doom_loop_detected",
      );
      expect(doomEvent).toBeUndefined();

      // Should have a doom_loop_filtered event for the 3rd turn
      const filterEvent = events.find(
        (e) => e.kind === "custom" && (e as { type: string }).type === "doom_loop_filtered",
      );
      expect(filterEvent).toBeDefined();

      // Turns 1-2: readFile + writeFile execute (4 calls)
      // Turn 3: only writeFile executes, readFile filtered (1 call)
      // Total: 5 tool calls (not 6)
      expect(toolCalls.length).toBe(5);
      // readFile only executed twice (filtered on 3rd turn)
      expect(toolCalls.filter((t) => t === "readFile").length).toBe(2);
      // writeFile executed all 3 times
      expect(toolCalls.filter((t) => t === "writeFile").length).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Truncated tool call detection (#1768)
  // ---------------------------------------------------------------------------

  describe("truncated tool calls (stopReason 'length')", () => {
    /** Helper: creates a stream that emits a completed tool call then done with stopReason "length". */
    function createTruncatedToolStream(
      toolName: string,
      id: string,
      args: string,
    ): () => AsyncIterable<ModelChunk> {
      return async function* (): AsyncIterable<ModelChunk> {
        yield { kind: "tool_call_start", toolName, callId: callId(id) };
        yield { kind: "tool_call_delta", callId: callId(id), delta: args };
        yield { kind: "tool_call_end", callId: callId(id) };
        yield {
          kind: "done",
          response: {
            content: "",
            model: "test-model",
            stopReason: "length",
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        };
      };
    }

    test("first truncation injects feedback and re-prompts model (recovery)", async () => {
      const toolCallExecuted: string[] = [];
      const handlers = createMockHandlers({
        modelStreams: [
          // Turn 1: truncated tool call
          createTruncatedToolStream("read_file", "tc1", '{"path": "foo.ts"}'),
          // Turn 2: model retries successfully with text-only response
          createTextStream("Here is the file content."),
        ],
        tools: [toolDesc("read_file")],
        toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
          toolCallExecuted.push(request.toolId);
          return { output: "file content" };
        },
      });

      const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

      // Tool must NOT have been executed (truncated turn skipped, retry was text-only)
      expect(toolCallExecuted).toHaveLength(0);

      // Should have a truncation_recovery custom event
      const recoveryEvent = events.find(
        (e) => e.kind === "custom" && (e as { type: string }).type === "truncation_recovery",
      );
      expect(recoveryEvent).toBeDefined();

      // Should complete successfully (model recovered with text)
      const done = events.find((e) => e.kind === "done") as Extract<
        EngineEvent,
        { readonly kind: "done" }
      >;
      expect(done).toBeDefined();
      expect(done.output.stopReason).toBe("completed");
    });

    test("recovery re-prompt allows model to retry with tool calls", async () => {
      const toolCallExecuted: string[] = [];
      const handlers = createMockHandlers({
        modelStreams: [
          // Turn 1: truncated tool call
          createTruncatedToolStream("read_file", "tc1", '{"path": "foo.ts"}'),
          // Turn 2: model retries with a proper tool call (not truncated)
          createToolCallStream("read_file", "tc2", '{"path": "bar.ts"}'),
          // Turn 3: model responds with text after tool result
          createTextStream("Done."),
        ],
        tools: [toolDesc("read_file")],
        toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
          toolCallExecuted.push(request.toolId);
          return { output: "file content" };
        },
      });

      const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

      // Tool executed on the retry turn (tc2), NOT on the truncated turn (tc1)
      expect(toolCallExecuted).toEqual(["read_file"]);

      const done = events.find((e) => e.kind === "done") as Extract<
        EngineEvent,
        { readonly kind: "done" }
      >;
      expect(done.output.stopReason).toBe("completed");
    });

    test("second truncation after recovery fails closed", async () => {
      const toolCallExecuted: string[] = [];
      const handlers = createMockHandlers({
        modelStreams: [
          // Turn 1: truncated
          createTruncatedToolStream("read_file", "tc1", '{"path": "foo.ts"}'),
          // Turn 2: truncated again (recovery exhausted)
          createTruncatedToolStream("read_file", "tc2", '{"path": "bar.ts"}'),
        ],
        tools: [toolDesc("read_file")],
        toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
          toolCallExecuted.push(request.toolId);
          return { output: "file content" };
        },
      });

      const events = await collect(runTurn({ callHandlers: handlers, messages: [] }));

      // No tools executed
      expect(toolCallExecuted).toHaveLength(0);

      // Recovery event from first truncation
      const recoveryEvent = events.find(
        (e) => e.kind === "custom" && (e as { type: string }).type === "truncation_recovery",
      );
      expect(recoveryEvent).toBeDefined();

      // Second truncation fails closed
      const done = events.find((e) => e.kind === "done") as Extract<
        EngineEvent,
        { readonly kind: "done" }
      >;
      expect(done).toBeDefined();
      expect(done.output.stopReason).toBe("error");

      const meta = done.output.metadata as Record<string, unknown>;
      expect(meta.source).toBe("model_stream");
    });
  });
});
