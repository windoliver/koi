import { describe, expect, test } from "bun:test";
import type { EngineEvent, ModelChunk, ToolCallId } from "@koi/core";
import { createReplayAdapter } from "./create-replay-adapter.js";

function callId(id: string): ToolCallId {
  return id as ToolCallId;
}

async function collectEvents(stream: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("createReplayAdapter — happy path", () => {
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
    const events = await collectEvents(
      createReplayAdapter(chunks).stream({ kind: "text", text: "hi" }),
    );
    // usage embedded in done.response.usage does not emit a separate custom event
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "text_delta", "done"]);
    const done = events.at(-1) as Extract<EngineEvent, { kind: "done" }>;
    expect(done.output.stopReason).toBe("completed");
    expect(done.output.metrics.inputTokens).toBe(5);
  });

  test("replays tool call stream", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "tool_call_start", toolName: "add", callId: callId("tc1") },
      { kind: "tool_call_delta", callId: callId("tc1"), delta: '{"a":7,"b":5}' },
      { kind: "tool_call_end", callId: callId("tc1") },
      {
        kind: "done",
        response: { content: "12", model: "test", usage: { inputTokens: 10, outputTokens: 3 } },
      },
    ];
    const events = await collectEvents(
      createReplayAdapter(chunks).stream({ kind: "text", text: "calc" }),
    );
    const toolEnd = events.find((e) => e.kind === "tool_call_end") as Extract<
      EngineEvent,
      { kind: "tool_call_end" }
    >;
    expect(toolEnd).toBeDefined();
    expect((toolEnd.result as { parsedArgs: unknown }).parsedArgs).toEqual({ a: 7, b: 5 });
  });

  test("has engineId 'replay'", () => {
    expect(createReplayAdapter([]).engineId).toBe("replay");
  });
});

// ---------------------------------------------------------------------------
// Failure modes (Issue 9A)
// ---------------------------------------------------------------------------

describe("createReplayAdapter — failure modes", () => {
  test("error chunk produces done with stopReason 'error'", async () => {
    const chunks: readonly ModelChunk[] = [{ kind: "error", message: "provider overloaded" }];
    const events = await collectEvents(
      createReplayAdapter(chunks).stream({ kind: "text", text: "hi" }),
    );
    const done = events.at(-1) as Extract<EngineEvent, { kind: "done" }>;
    expect(done.kind).toBe("done");
    expect(done.output.stopReason).toBe("error");
    expect(done.output.metadata?.error).toBe("provider overloaded");
  });

  test("empty chunk array produces done with stopReason 'error' (truncated stream)", async () => {
    const events = await collectEvents(
      createReplayAdapter([]).stream({ kind: "text", text: "hi" }),
    );
    const done = events.at(-1) as Extract<EngineEvent, { kind: "done" }>;
    expect(done.kind).toBe("done");
    expect(done.output.stopReason).toBe("error");
    expect(done.output.metadata?.error).toBe("stream ended without terminal chunk");
  });

  test("cassette exhausted without done chunk produces error stop (truncated cassette)", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "partial" },
      // no done chunk — simulates truncated cassette
    ];
    const events = await collectEvents(
      createReplayAdapter(chunks).stream({ kind: "text", text: "hi" }),
    );
    const done = events.at(-1) as Extract<EngineEvent, { kind: "done" }>;
    expect(done.output.stopReason).toBe("error");
  });

  test("stream() is stateless — second call replays from start", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "A" },
      { kind: "done", response: { content: "A", model: "test" } },
    ];
    const adapter = createReplayAdapter(chunks);
    const first = await collectEvents(adapter.stream({ kind: "text", text: "1" }));
    const second = await collectEvents(adapter.stream({ kind: "text", text: "2" }));
    // Both calls should produce the same events
    expect(first.map((e) => e.kind)).toEqual(second.map((e) => e.kind));
  });

  test("respects caller abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "should not complete" },
      { kind: "done", response: { content: "done", model: "test" } },
    ];
    const events = await collectEvents(
      createReplayAdapter(chunks).stream({ kind: "text", text: "hi", signal: controller.signal }),
    );
    const done = events.at(-1) as Extract<EngineEvent, { kind: "done" }>;
    expect(done.kind).toBe("done");
    expect(done.output.stopReason).toBe("interrupted");
  });
});
