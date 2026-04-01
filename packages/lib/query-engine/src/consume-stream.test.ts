import { describe, expect, test } from "bun:test";
import type { EngineEvent, ModelChunk, ToolCallId } from "@koi/core";
import { consumeModelStream } from "./consume-stream.js";

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
    // Result should indicate the parse failure with the raw args and undefined parsedArgs
    const result = endEvent.result as {
      readonly toolName: string;
      readonly callId: ToolCallId;
      readonly rawArgs: string;
      readonly parsedArgs: undefined;
    };
    expect(result.toolName).toBe("bad_tool");
    expect(result.rawArgs).toBe('{"broken": ');
    expect(result.parsedArgs).toBeUndefined();
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

  test("error chunk yields error-shaped done event", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "partial" },
      { kind: "error", message: "rate limit exceeded", usage: { inputTokens: 5, outputTokens: 0 } },
    ];

    const events = await collect(consumeModelStream(toStream(chunks)));
    const last = events.at(-1);
    expect(last).toBeDefined();

    expect(last?.kind).toBe("done");
    const done = last as Extract<EngineEvent, { readonly kind: "done" }>;
    expect(done.output.stopReason).toBe("error");
  });

  test("empty stream with just done produces done event", async () => {
    const chunks: readonly ModelChunk[] = [{ kind: "done", response: DONE_RESPONSE }];

    const events = await collect(consumeModelStream(toStream(chunks)));

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("done");
    const done = events[0] as Extract<EngineEvent, { readonly kind: "done" }>;
    expect(done.output.stopReason).toBe("completed");
    expect(done.output.metrics.inputTokens).toBe(10);
    expect(done.output.metrics.outputTokens).toBe(5);
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
