import { describe, expect, test } from "bun:test";
import type { EngineEvent, ModelChunk, ToolCallId } from "@koi/core";
import { consumeModelStream } from "./consume-stream.js";
import type { AccumulatedToolCall } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callId(id: string): ToolCallId {
  return id as ToolCallId;
}

async function* toStream(chunks: readonly ModelChunk[]): AsyncIterable<ModelChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function collect(stream: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

const DONE_RESPONSE = {
  content: "",
  model: "test-model",
  usage: { inputTokens: 10, outputTokens: 5 },
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("consumeModelStream", () => {
  test("interleaved text + tool chunks preserve event order", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "Hello " },
      { kind: "tool_call_start", toolName: "read_file", callId: callId("tc1") },
      { kind: "text_delta", delta: "world" },
      { kind: "tool_call_delta", callId: callId("tc1"), delta: '{"path":' },
      { kind: "tool_call_delta", callId: callId("tc1"), delta: '"foo.ts"}' },
      { kind: "tool_call_end", callId: callId("tc1") },
      { kind: "done", response: DONE_RESPONSE },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const kinds = events.map((e) => e.kind);

    expect(kinds).toEqual([
      "text_delta",
      "tool_call_start",
      "text_delta",
      "tool_call_delta",
      "tool_call_delta",
      "tool_call_end",
      "done",
    ]);
  });

  test("streamed tool-call args split across multiple chunks are reassembled correctly", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "tool_call_start", toolName: "write_file", callId: callId("tc1") },
      { kind: "tool_call_delta", callId: callId("tc1"), delta: '{"pa' },
      { kind: "tool_call_delta", callId: callId("tc1"), delta: 'th": "/tmp/x",' },
      { kind: "tool_call_delta", callId: callId("tc1"), delta: ' "content": "hi"}' },
      { kind: "tool_call_end", callId: callId("tc1") },
      { kind: "done", response: DONE_RESPONSE },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const endEvent = events.find((e) => e.kind === "tool_call_end" && e.callId === callId("tc1"));

    expect(endEvent).toBeDefined();
    expect(endEvent?.kind).toBe("tool_call_end");
    // The result should contain the parsed args
    expect((endEvent as Extract<EngineEvent, { readonly kind: "tool_call_end" }>).result).toEqual({
      toolName: "write_file",
      callId: callId("tc1"),
      rawArgs: '{"path": "/tmp/x", "content": "hi"}',
      parsedArgs: { path: "/tmp/x", content: "hi" },
    });
  });

  test("malformed partial tool-call JSON yields deterministic error", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "tool_call_start", toolName: "bad_tool", callId: callId("tc1") },
      { kind: "tool_call_delta", callId: callId("tc1"), delta: '{"broken": ' },
      { kind: "tool_call_end", callId: callId("tc1") },
      { kind: "done", response: DONE_RESPONSE },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const endEvent = events.find(
      (e) => e.kind === "tool_call_end" && e.callId === callId("tc1"),
    ) as Extract<EngineEvent, { readonly kind: "tool_call_end" }>;

    expect(endEvent).toBeDefined();
    const result = endEvent.result as {
      readonly toolName: string;
      readonly callId: ToolCallId;
      readonly rawArgs: string;
      readonly parsedArgs: undefined;
      readonly parseError: string;
    };
    expect(result.toolName).toBe("bad_tool");
    expect(result.rawArgs).toBe('{"broken": ');
    expect(result.parsedArgs).toBeUndefined();
    // parseError must be set so callers can discriminate failures from valid empty args
    expect(result.parseError).toBeTypeOf("string");
    expect(result.parseError.length).toBeGreaterThan(0);
  });

  test("non-object JSON args (array) are treated as parse failure", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "tool_call_start", toolName: "bad_tool", callId: callId("tc1") },
      { kind: "tool_call_delta", callId: callId("tc1"), delta: "[1, 2, 3]" },
      { kind: "tool_call_end", callId: callId("tc1") },
      { kind: "done", response: DONE_RESPONSE },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const endEvent = events.find(
      (e) => e.kind === "tool_call_end" && e.callId === callId("tc1"),
    ) as Extract<EngineEvent, { readonly kind: "tool_call_end" }>;

    const result = endEvent.result as AccumulatedToolCall;
    expect(result.parsedArgs).toBeUndefined();
    expect(result.parseError).toContain("array");
  });

  test("non-object JSON args (string) are treated as parse failure", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "tool_call_start", toolName: "bad_tool", callId: callId("tc1") },
      { kind: "tool_call_delta", callId: callId("tc1"), delta: '"just a string"' },
      { kind: "tool_call_end", callId: callId("tc1") },
      { kind: "done", response: DONE_RESPONSE },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const endEvent = events.find(
      (e) => e.kind === "tool_call_end" && e.callId === callId("tc1"),
    ) as Extract<EngineEvent, { readonly kind: "tool_call_end" }>;

    const result = endEvent.result as AccumulatedToolCall;
    expect(result.parsedArgs).toBeUndefined();
    expect(result.parseError).toContain("string");
  });

  test("multiple tool calls in one response are all accumulated correctly", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "tool_call_start", toolName: "read", callId: callId("tc1") },
      { kind: "tool_call_start", toolName: "write", callId: callId("tc2") },
      { kind: "tool_call_delta", callId: callId("tc1"), delta: '{"a": 1}' },
      { kind: "tool_call_delta", callId: callId("tc2"), delta: '{"b": 2}' },
      { kind: "tool_call_end", callId: callId("tc1") },
      { kind: "tool_call_end", callId: callId("tc2") },
      { kind: "done", response: DONE_RESPONSE },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));

    const end1 = events.find(
      (e) => e.kind === "tool_call_end" && e.callId === callId("tc1"),
    ) as Extract<EngineEvent, { readonly kind: "tool_call_end" }>;

    const end2 = events.find(
      (e) => e.kind === "tool_call_end" && e.callId === callId("tc2"),
    ) as Extract<EngineEvent, { readonly kind: "tool_call_end" }>;

    expect((end1.result as { readonly parsedArgs: unknown }).parsedArgs).toEqual({ a: 1 });
    expect((end2.result as { readonly parsedArgs: unknown }).parsedArgs).toEqual({ b: 2 });
  });

  test("usage chunks are not yielded as separate events", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "hi" },
      { kind: "usage", inputTokens: 10, outputTokens: 5 },
      { kind: "done", response: DONE_RESPONSE },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const kinds = events.map((e) => e.kind);

    expect(kinds).not.toContain("usage");
    expect(kinds).toEqual(["text_delta", "done"]);
  });

  test("final done usage overrides incremental usage totals", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "usage", inputTokens: 3, outputTokens: 2 },
      { kind: "done", response: DONE_RESPONSE },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const done = events.at(-1) as Extract<EngineEvent, { readonly kind: "done" }>;

    expect(done.output.metrics.inputTokens).toBe(10);
    expect(done.output.metrics.outputTokens).toBe(5);
    expect(done.output.metrics.totalTokens).toBe(15);
  });

  test("error chunk yields error-shaped done event and preserves partial text", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "partial " },
      { kind: "text_delta", delta: "output" },
      { kind: "error", message: "rate limit exceeded", usage: { inputTokens: 5, outputTokens: 0 } },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const last = events.at(-1);
    expect(last).toBeDefined();

    expect(last?.kind).toBe("done");
    const done = last as Extract<EngineEvent, { readonly kind: "done" }>;
    expect(done.output.stopReason).toBe("error");
    // Partial text must be preserved even on provider error
    expect(done.output.content).toEqual([{ kind: "text", text: "partial output" }]);
    expect((done.output.metadata as { readonly error: string }).error).toBe("rate limit exceeded");
  });

  test("error chunk surfaces dangling in-flight tool calls in metadata", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "tool_call_start", toolName: "read_file", callId: callId("tc1") },
      { kind: "tool_call_delta", callId: callId("tc1"), delta: '{"path":' },
      { kind: "error", message: "provider crashed" },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const done = events.at(-1) as Extract<EngineEvent, { readonly kind: "done" }>;
    expect(done.output.stopReason).toBe("error");

    const meta = done.output.metadata as {
      readonly danglingToolCalls: readonly {
        readonly callId: string;
        readonly toolName: string;
        readonly partialArgs: string;
      }[];
    };
    expect(meta.danglingToolCalls).toHaveLength(1);
    expect(meta.danglingToolCalls[0]?.callId).toBe(callId("tc1"));
    expect(meta.danglingToolCalls[0]?.toolName).toBe("read_file");
    expect(meta.danglingToolCalls[0]?.partialArgs).toBe('{"path":');
  });

  test("truncated stream surfaces dangling tool calls in metadata", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "tool_call_start", toolName: "write_file", callId: callId("tc1") },
      { kind: "tool_call_delta", callId: callId("tc1"), delta: '{"content": "hi"' },
      // Stream ends without done or error
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const done = events.at(-1) as Extract<EngineEvent, { readonly kind: "done" }>;
    expect(done.output.stopReason).toBe("error");

    const meta = done.output.metadata as {
      readonly danglingToolCalls: readonly {
        readonly callId: string;
        readonly toolName: string;
        readonly partialArgs: string;
      }[];
    };
    expect(meta.danglingToolCalls).toHaveLength(1);
    expect(meta.danglingToolCalls[0]?.callId).toBe(callId("tc1"));
  });

  test("error chunk with no prior text yields empty content", async () => {
    const chunks: readonly ModelChunk[] = [{ kind: "error", message: "auth failed" }];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const done = events[0] as Extract<EngineEvent, { readonly kind: "done" }>;
    expect(done.output.stopReason).toBe("error");
    expect(done.output.content).toEqual([]);
  });

  test("empty stream with just done produces done event", async () => {
    const chunks: readonly ModelChunk[] = [{ kind: "done", response: DONE_RESPONSE }];

    const events = await collect(consumeModelStream(toStream(chunks)));

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("done");
    const done = events[0] as Extract<EngineEvent, { readonly kind: "done" }>;
    expect(done.output.stopReason).toBe("completed");
    expect(done.output.content).toEqual([]);
    expect(done.output.metrics.inputTokens).toBe(10);
    expect(done.output.metrics.outputTokens).toBe(5);
  });

  test("done event preserves final response text", async () => {
    const chunks: readonly ModelChunk[] = [
      {
        kind: "done",
        response: {
          content: "final answer",
          model: "test-model",
        },
      },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const done = events[0] as Extract<EngineEvent, { readonly kind: "done" }>;

    expect(done.output.content).toEqual([{ kind: "text", text: "final answer" }]);
  });

  test("truncated stream without terminal chunk preserves partial text", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "partial " },
      { kind: "text_delta", delta: "response" },
      { kind: "usage", inputTokens: 7, outputTokens: 3 },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const last = events.at(-1);
    expect(last).toBeDefined();
    expect(last?.kind).toBe("done");

    const done = last as Extract<EngineEvent, { readonly kind: "done" }>;
    expect(done.output.stopReason).toBe("error");
    expect(done.output.content).toEqual([{ kind: "text", text: "partial response" }]);
    expect(done.output.metrics.inputTokens).toBe(7);
    expect(done.output.metrics.outputTokens).toBe(3);
    expect((done.output.metadata as { readonly error: string }).error).toBe(
      "stream ended without terminal chunk",
    );
  });

  test("empty stream (no chunks at all) yields error done event", async () => {
    const chunks: readonly ModelChunk[] = [];

    const events = await collect(consumeModelStream(toStream(chunks)));
    expect(events).toHaveLength(1);

    const done = events[0] as Extract<EngineEvent, { readonly kind: "done" }>;
    expect(done.output.stopReason).toBe("error");
    expect(done.output.metrics.totalTokens).toBe(0);
  });

  test("done with empty content falls back to accumulated text deltas", async () => {
    // Some providers stream text via deltas but send an empty terminal content
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "Hello " },
      { kind: "text_delta", delta: "world" },
      {
        kind: "done",
        response: { content: "", model: "test-model", usage: { inputTokens: 5, outputTokens: 2 } },
      },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const done = events.at(-1) as Extract<EngineEvent, { readonly kind: "done" }>;

    expect(done.output.stopReason).toBe("completed");
    expect(done.output.content).toEqual([{ kind: "text", text: "Hello world" }]);
  });

  test("done with non-empty content takes precedence over accumulated deltas", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "streamed" },
      { kind: "done", response: { content: "authoritative", model: "test-model" } },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const done = events.at(-1) as Extract<EngineEvent, { readonly kind: "done" }>;

    expect(done.output.content).toEqual([{ kind: "text", text: "authoritative" }]);
  });

  test("thinking_delta chunks are passed through", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "thinking_delta", delta: "Let me think..." },
      { kind: "text_delta", delta: "Answer" },
      { kind: "done", response: DONE_RESPONSE },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    expect(events[0]).toEqual({ kind: "thinking_delta", delta: "Let me think..." });
    expect(events[1]).toEqual({ kind: "text_delta", delta: "Answer" });
  });
});
