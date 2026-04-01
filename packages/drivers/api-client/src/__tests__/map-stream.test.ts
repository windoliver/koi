import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelChunk } from "@koi/core";
import { mapAnthropicStream } from "../map-stream.js";

type RawEvent = Anthropic.RawMessageStreamEvent;

/** Helper to collect all chunks from the stream mapper. */
async function collectChunks(events: readonly RawEvent[]): Promise<readonly ModelChunk[]> {
  async function* generate(): AsyncIterable<RawEvent> {
    for (const event of events) {
      yield event;
    }
  }

  const chunks: ModelChunk[] = [];
  for await (const chunk of mapAnthropicStream(generate(), "claude-sonnet-4-5-20250929")) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("mapAnthropicStream", () => {
  test("maps text_delta events", async () => {
    const events: readonly RawEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "", citations: null },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ];

    const chunks = await collectChunks(events);

    // Should have text deltas + usage + done
    const textDeltas = chunks.filter((c) => c.kind === "text_delta");
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0]?.kind === "text_delta" && textDeltas[0]?.delta).toBe("Hello");
    expect(textDeltas[1]?.kind === "text_delta" && textDeltas[1]?.delta).toBe(" world");

    // Final done chunk
    const done = chunks.find((c) => c.kind === "done");
    expect(done).toBeDefined();
    if (done?.kind === "done") {
      expect(done?.response.content).toBe("Hello world");
      expect(done?.response.model).toBe("claude-sonnet-4-5-20250929");
    }
  });

  test("maps tool_use streaming events", async () => {
    const events: readonly RawEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_1", name: "read_file", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"/tmp"}' },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 8 },
      },
      { type: "message_stop" },
    ];

    const chunks = await collectChunks(events);

    const toolStart = chunks.find((c) => c.kind === "tool_call_start");
    expect(toolStart).toBeDefined();
    if (toolStart?.kind === "tool_call_start") {
      expect(toolStart?.toolName).toBe("read_file");
    }

    const toolDeltas = chunks.filter((c) => c.kind === "tool_call_delta");
    expect(toolDeltas).toHaveLength(2);

    const toolEnd = chunks.find((c) => c.kind === "tool_call_end");
    expect(toolEnd).toBeDefined();
  });

  test("maps thinking_delta events", async () => {
    const events: readonly RawEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_3",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 5,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think..." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      },
      { type: "message_stop" },
    ];

    const chunks = await collectChunks(events);

    const thinkingDeltas = chunks.filter((c) => c.kind === "thinking_delta");
    expect(thinkingDeltas).toHaveLength(1);
    if (thinkingDeltas[0]?.kind === "thinking_delta") {
      expect(thinkingDeltas[0]?.delta).toBe("Let me think...");
    }
  });

  test("emits usage chunk from message_delta", async () => {
    const events: readonly RawEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_4",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 42 },
      },
      { type: "message_stop" },
    ];

    const chunks = await collectChunks(events);
    const usageChunk = chunks.find((c) => c.kind === "usage");
    expect(usageChunk).toBeDefined();
    if (usageChunk?.kind === "usage") {
      expect(usageChunk?.outputTokens).toBe(42);
    }
  });

  test("always emits a done chunk at the end", async () => {
    const events: readonly RawEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_5",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      { type: "message_stop" },
    ];

    const chunks = await collectChunks(events);
    const last = chunks[chunks.length - 1];
    expect(last?.kind).toBe("done");
  });
});
