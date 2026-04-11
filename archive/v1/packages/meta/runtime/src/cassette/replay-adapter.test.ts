import { describe, expect, test } from "bun:test";
import type { EngineEvent, ModelChunk, ToolCallId } from "@koi/core";
import { createReplayAdapter } from "./replay-adapter.js";

function callId(id: string): ToolCallId {
  return id as ToolCallId;
}

describe("createReplayAdapter", () => {
  test("replays text stream producing done event", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "Hello" },
      { kind: "text_delta", delta: " world" },
      {
        kind: "done",
        response: {
          content: "Hello world",
          model: "test",
          usage: { inputTokens: 5, outputTokens: 2 },
        },
      },
    ];

    const adapter = createReplayAdapter(chunks);
    const events: EngineEvent[] = [];
    for await (const event of adapter.stream({ kind: "text", text: "test" })) {
      events.push(event);
    }

    expect(events.map((e) => e.kind)).toEqual(["text_delta", "text_delta", "done"]);
    const done = events.at(-1) as Extract<EngineEvent, { readonly kind: "done" }>;
    expect(done.output.stopReason).toBe("completed");
    expect(done.output.metrics.inputTokens).toBe(5);
  });

  test("replays tool call stream with accumulation", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "tool_call_start", toolName: "add", callId: callId("tc1") },
      { kind: "tool_call_delta", callId: callId("tc1"), delta: '{"a": 7, "b": 5}' },
      { kind: "tool_call_end", callId: callId("tc1") },
      {
        kind: "done",
        response: {
          content: "12",
          model: "test",
          usage: { inputTokens: 10, outputTokens: 3 },
        },
      },
    ];

    const adapter = createReplayAdapter(chunks);
    const events: EngineEvent[] = [];
    for await (const event of adapter.stream({ kind: "text", text: "test" })) {
      events.push(event);
    }

    const toolEnd = events.find((e) => e.kind === "tool_call_end") as Extract<
      EngineEvent,
      { readonly kind: "tool_call_end" }
    >;
    expect(toolEnd).toBeDefined();
    const result = toolEnd.result as { readonly parsedArgs: unknown };
    expect(result.parsedArgs).toEqual({ a: 7, b: 5 });
  });

  test("has engineId replay", () => {
    const adapter = createReplayAdapter([]);
    expect(adapter.engineId).toBe("replay");
  });

  test("respects caller abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "should not complete" },
      {
        kind: "done",
        response: {
          content: "done",
          model: "test",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      },
    ];

    const adapter = createReplayAdapter(chunks);
    const events: EngineEvent[] = [];
    for await (const event of adapter.stream({
      kind: "text",
      text: "test",
      signal: controller.signal,
    })) {
      events.push(event);
    }

    const last = events.at(-1) as Extract<EngineEvent, { readonly kind: "done" }>;
    expect(last.kind).toBe("done");
    expect(last.output.stopReason).toBe("interrupted");
  });
});
