import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import type {
  SdkAssistantMessage,
  SdkResultMessage,
  SdkStreamEvent,
  SdkStreamEventMessage,
  SdkSystemMessage,
  SdkUserMessage,
} from "./event-map.js";
import {
  createMessageMapper,
  createStreamEventMapper,
  mapAssistantMessage,
  mapResultMessage,
  mapSdkMessage,
  mapStopReason,
  mapUserMessage,
} from "./event-map.js";

// ---------------------------------------------------------------------------
// mapStopReason
// ---------------------------------------------------------------------------

describe("mapStopReason", () => {
  test("maps success → completed", () => {
    expect(mapStopReason("success")).toBe("completed");
  });

  test("maps error_max_turns → max_turns", () => {
    expect(mapStopReason("error_max_turns")).toBe("max_turns");
  });

  test("maps error_max_budget_usd → interrupted", () => {
    expect(mapStopReason("error_max_budget_usd")).toBe("interrupted");
  });

  test("maps error_during_execution → error", () => {
    expect(mapStopReason("error_during_execution")).toBe("error");
  });

  test("maps error_max_structured_output_retries → error", () => {
    expect(mapStopReason("error_max_structured_output_retries")).toBe("error");
  });

  test("maps unknown subtype → error (default guard)", () => {
    expect(mapStopReason("something_unexpected")).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// mapAssistantMessage
// ---------------------------------------------------------------------------

describe("mapAssistantMessage", () => {
  test("extracts text_delta from text content blocks", () => {
    const msg: SdkAssistantMessage = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello, world!" }],
      },
    };

    const events = mapAssistantMessage(msg);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "text_delta", delta: "Hello, world!" });
  });

  test("extracts tool_call_start from tool_use blocks", () => {
    const msg: SdkAssistantMessage = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "call-123",
            name: "search",
            input: { query: "test" },
          },
        ],
      },
    };

    const events = mapAssistantMessage(msg);

    expect(events).toHaveLength(1);
    const event = events[0] as EngineEvent & { readonly kind: "tool_call_start" };
    expect(event.kind).toBe("tool_call_start");
    expect(event.toolName).toBe("search");
    expect(event.callId).toBe("call-123");
    expect(event.args).toEqual({ query: "test" });
  });

  test("handles mixed text and tool_use blocks", () => {
    const msg: SdkAssistantMessage = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me search for that." },
          { type: "tool_use", id: "call-1", name: "search", input: { q: "test" } },
          { type: "text", text: "Found the results." },
        ],
      },
    };

    const events = mapAssistantMessage(msg);

    expect(events).toHaveLength(3);
    expect(events[0]?.kind).toBe("text_delta");
    expect(events[1]?.kind).toBe("tool_call_start");
    expect(events[2]?.kind).toBe("text_delta");
  });

  test("returns empty array for message with no content", () => {
    const msg: SdkAssistantMessage = {
      type: "assistant",
      message: { content: [] },
    };

    expect(mapAssistantMessage(msg)).toHaveLength(0);
  });

  test("returns empty array for message without message property", () => {
    const msg: SdkAssistantMessage = {
      type: "assistant",
    };

    expect(mapAssistantMessage(msg)).toHaveLength(0);
  });

  test("skips text blocks with empty text", () => {
    const msg: SdkAssistantMessage = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "" }],
      },
    };

    expect(mapAssistantMessage(msg)).toHaveLength(0);
  });

  test("skips tool_use blocks missing id or name", () => {
    const msg: SdkAssistantMessage = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", input: { q: "test" } }],
      },
    };

    expect(mapAssistantMessage(msg)).toHaveLength(0);
  });

  test("defaults tool_use input to empty object", () => {
    const msg: SdkAssistantMessage = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "call-1", name: "read" }],
      },
    };

    const events = mapAssistantMessage(msg);
    const event = events[0] as EngineEvent & { readonly kind: "tool_call_start" };
    expect(event.args).toEqual({});
  });

  test("ignores unknown block types gracefully", () => {
    const msg: SdkAssistantMessage = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello" },
          { type: "thinking", text: "reasoning..." },
        ],
      },
    };

    const events = mapAssistantMessage(msg);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("text_delta");
  });
});

// ---------------------------------------------------------------------------
// mapResultMessage
// ---------------------------------------------------------------------------

describe("mapResultMessage", () => {
  test("maps success result to done event", () => {
    const msg: SdkResultMessage = {
      type: "result",
      subtype: "success",
      result: "Task completed successfully.",
      num_turns: 5,
      duration_ms: 10000,
      usage: { input_tokens: 2000, output_tokens: 800 },
    };

    const event = mapResultMessage(msg);

    expect(event.kind).toBe("done");
    if (event.kind === "done") {
      expect(event.output.stopReason).toBe("completed");
      expect(event.output.metrics.inputTokens).toBe(2000);
      expect(event.output.metrics.outputTokens).toBe(800);
      expect(event.output.metrics.totalTokens).toBe(2800);
      expect(event.output.metrics.turns).toBe(5);
      expect(event.output.content).toHaveLength(1);
    }
  });

  test("maps error_max_turns to max_turns stop reason", () => {
    const msg: SdkResultMessage = {
      type: "result",
      subtype: "error_max_turns",
      errors: ["Hit max turns limit"],
      num_turns: 25,
      duration_ms: 60000,
      usage: { input_tokens: 50000, output_tokens: 20000 },
    };

    const event = mapResultMessage(msg);
    if (event.kind === "done") {
      expect(event.output.stopReason).toBe("max_turns");
    }
  });

  test("maps error_max_budget_usd to interrupted stop reason", () => {
    const msg: SdkResultMessage = {
      type: "result",
      subtype: "error_max_budget_usd",
      num_turns: 10,
      duration_ms: 30000,
      total_cost_usd: 5.0,
      usage: { input_tokens: 30000, output_tokens: 10000 },
    };

    const event = mapResultMessage(msg);
    if (event.kind === "done") {
      expect(event.output.stopReason).toBe("interrupted");
      expect(event.output.metadata?.totalCostUsd).toBe(5.0);
    }
  });

  test("maps error_during_execution to error stop reason", () => {
    const msg: SdkResultMessage = {
      type: "result",
      subtype: "error_during_execution",
      errors: ["Runtime error occurred"],
      num_turns: 2,
      duration_ms: 5000,
      usage: { input_tokens: 500, output_tokens: 100 },
    };

    const event = mapResultMessage(msg);
    if (event.kind === "done") {
      expect(event.output.stopReason).toBe("error");
    }
  });

  test("handles result with empty result text", () => {
    const msg: SdkResultMessage = {
      type: "result",
      subtype: "success",
      result: "",
      num_turns: 1,
      duration_ms: 1000,
      usage: { input_tokens: 100, output_tokens: 50 },
    };

    const event = mapResultMessage(msg);
    if (event.kind === "done") {
      expect(event.output.content).toHaveLength(0);
    }
  });

  test("handles result with missing result text", () => {
    const msg: SdkResultMessage = {
      type: "result",
      subtype: "success",
      num_turns: 1,
      duration_ms: 1000,
      usage: {},
    };

    const event = mapResultMessage(msg);
    if (event.kind === "done") {
      expect(event.output.content).toHaveLength(0);
      expect(event.output.metrics.inputTokens).toBe(0);
    }
  });

  test("includes rich metadata when present", () => {
    const msg: SdkResultMessage = {
      type: "result",
      subtype: "success",
      result: "Done",
      num_turns: 1,
      duration_ms: 1000,
      duration_api_ms: 800,
      total_cost_usd: 0.02,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 10,
      },
      modelUsage: { "claude-sonnet-4-5-20250929": { input_tokens: 100 } },
    };

    const event = mapResultMessage(msg);
    if (event.kind === "done") {
      expect(event.output.metadata).toBeDefined();
      expect(event.output.metadata?.totalCostUsd).toBe(0.02);
      expect(event.output.metadata?.apiDurationMs).toBe(800);
    }
  });
});

// ---------------------------------------------------------------------------
// createStreamEventMapper
// ---------------------------------------------------------------------------

describe("createStreamEventMapper", () => {
  test("maps content_block_start with tool_use to tool_call_start", () => {
    const mapper = createStreamEventMapper();

    const event: SdkStreamEvent = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call-1", name: "search" },
    };

    const events = mapper.map(event);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "tool_call_start",
      toolName: "search",
      callId: "call-1",
    });
  });

  test("maps content_block_delta with text_delta", () => {
    const mapper = createStreamEventMapper();

    const event: SdkStreamEvent = {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hello" },
    };

    const events = mapper.map(event);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "text_delta", delta: "Hello" });
  });

  test("maps content_block_delta with input_json_delta to tool_call_delta", () => {
    const mapper = createStreamEventMapper();

    // First register the tool call
    mapper.map({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "call-2", name: "write" },
    });

    // Then receive the delta
    const events = mapper.map({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "tool_call_delta",
      callId: "call-2",
      delta: '{"path":',
    });
  });

  test("ignores input_json_delta without prior tool_call_start", () => {
    const mapper = createStreamEventMapper();

    const events = mapper.map({
      type: "content_block_delta",
      index: 99,
      delta: { type: "input_json_delta", partial_json: '{"q":' },
    });

    expect(events).toHaveLength(0);
  });

  test("cleans up tool call tracking on content_block_stop", () => {
    const mapper = createStreamEventMapper();

    mapper.map({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call-1", name: "read" },
    });

    mapper.map({ type: "content_block_stop", index: 0 });

    // Delta after stop should not find the tool
    const events = mapper.map({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "data" },
    });

    expect(events).toHaveLength(0);
  });

  test("ignores unknown event types", () => {
    const mapper = createStreamEventMapper();

    const events = mapper.map({ type: "message_start" });

    expect(events).toHaveLength(0);
  });

  test("handles empty text_delta", () => {
    const mapper = createStreamEventMapper();

    const events = mapper.map({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "" },
    });

    expect(events).toHaveLength(0);
  });

  test("handles content_block_start without content_block", () => {
    const mapper = createStreamEventMapper();

    const events = mapper.map({ type: "content_block_start" });

    expect(events).toHaveLength(0);
  });

  test("handles content_block_delta without delta", () => {
    const mapper = createStreamEventMapper();

    const events = mapper.map({ type: "content_block_delta" });

    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mapUserMessage
// ---------------------------------------------------------------------------

describe("mapUserMessage", () => {
  test("extracts tool_call_end from tool_result blocks", () => {
    const msg: SdkUserMessage = {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "Search results here" }],
      },
    };

    const events = mapUserMessage(msg);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "tool_call_end",
      callId: "call-1",
      result: "Search results here",
    });
  });

  test("returns empty for user message without tool_result", () => {
    const msg: SdkUserMessage = {
      type: "user",
      message: {
        content: [{ type: "text", text: "Hello" }],
      },
    };

    const events = mapUserMessage(msg);
    expect(events).toHaveLength(0);
  });

  test("handles string content in tool_result", () => {
    const msg: SdkUserMessage = {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "call-2", content: "plain text result" }],
      },
    };

    const events = mapUserMessage(msg);

    expect(events).toHaveLength(1);
    const event = events[0] as EngineEvent & { readonly kind: "tool_call_end" };
    expect(event.result).toBe("plain text result");
  });

  test("handles array content in tool_result", () => {
    const msg: SdkUserMessage = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-3",
            content: [
              { type: "text", text: "part one" },
              { type: "text", text: " part two" },
            ],
          },
        ],
      },
    };

    const events = mapUserMessage(msg);

    expect(events).toHaveLength(1);
    const event = events[0] as EngineEvent & { readonly kind: "tool_call_end" };
    expect(event.result).toBe("part one part two");
  });

  test("returns empty for user message with no content", () => {
    const msg: SdkUserMessage = {
      type: "user",
      message: { content: [] },
    };

    expect(mapUserMessage(msg)).toHaveLength(0);
  });

  test("returns empty for user message without message property", () => {
    const msg: SdkUserMessage = { type: "user" };

    expect(mapUserMessage(msg)).toHaveLength(0);
  });

  test("extracts multiple tool_call_end events", () => {
    const msg: SdkUserMessage = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "call-a", content: "result A" },
          { type: "tool_result", tool_use_id: "call-b", content: "result B" },
        ],
      },
    };

    const events = mapUserMessage(msg);
    expect(events).toHaveLength(2);
    expect((events[0] as EngineEvent & { readonly kind: "tool_call_end" }).callId).toBe("call-a");
    expect((events[1] as EngineEvent & { readonly kind: "tool_call_end" }).callId).toBe("call-b");
  });

  test("defaults to empty string when content is undefined", () => {
    const msg: SdkUserMessage = {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "call-4" }],
      },
    };

    const events = mapUserMessage(msg);
    expect(events).toHaveLength(1);
    const event = events[0] as EngineEvent & { readonly kind: "tool_call_end" };
    expect(event.result).toBe("");
  });

  test("skips tool_result blocks without tool_use_id", () => {
    const msg: SdkUserMessage = {
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "orphan result" }],
      },
    };

    expect(mapUserMessage(msg)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mapSdkMessage
// ---------------------------------------------------------------------------

describe("mapSdkMessage", () => {
  test("maps system init message and captures session_id", () => {
    const msg: SdkSystemMessage = {
      type: "system",
      subtype: "init",
      session_id: "sess-abc-123",
    };

    const result = mapSdkMessage(msg);

    expect(result.sessionId).toBe("sess-abc-123");
    expect(result.events).toHaveLength(0);
    expect(result.isDone).toBe(false);
  });

  test("maps system message without init subtype (unknown subtypes ignored)", () => {
    const msg: SdkSystemMessage = {
      type: "system",
      subtype: "heartbeat",
    };

    const result = mapSdkMessage(msg);

    expect(result.sessionId).toBeUndefined();
    expect(result.events).toHaveLength(0);
    expect(result.isDone).toBe(false);
  });

  test("emits custom event for compact_boundary", () => {
    const msg: SdkSystemMessage = {
      type: "system",
      subtype: "compact_boundary",
      session_id: "sess-compact",
    };

    const result = mapSdkMessage(msg);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.kind).toBe("custom");
    const event = result.events[0] as EngineEvent & { readonly kind: "custom" };
    expect(event.type).toBe("compact_boundary");
    expect((event.data as Record<string, unknown>).sessionId).toBe("sess-compact");
    expect(result.isDone).toBe(false);
  });

  test("includes compact_metadata in compact_boundary data", () => {
    const msg: SdkSystemMessage = {
      type: "system",
      subtype: "compact_boundary",
      session_id: "sess-compact-2",
      compact_metadata: { trigger: "token_limit", pre_tokens: 50000 },
    };

    const result = mapSdkMessage(msg);

    expect(result.events).toHaveLength(1);
    const event = result.events[0] as EngineEvent & { readonly kind: "custom" };
    const data = event.data as Record<string, unknown>;
    expect(data.compactMetadata).toEqual({ trigger: "token_limit", pre_tokens: 50000 });
  });

  test("maps assistant message to events", () => {
    const msg: SdkAssistantMessage = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello!" }],
      },
    };

    const result = mapSdkMessage(msg);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.kind).toBe("text_delta");
    expect(result.isDone).toBe(false);
  });

  test("maps result message to done event", () => {
    const msg: SdkResultMessage = {
      type: "result",
      subtype: "success",
      session_id: "sess-xyz",
      result: "Done!",
      num_turns: 1,
      duration_ms: 500,
      usage: { input_tokens: 50, output_tokens: 20 },
    };

    const result = mapSdkMessage(msg);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.kind).toBe("done");
    expect(result.sessionId).toBe("sess-xyz");
    expect(result.isDone).toBe(true);
  });

  test("handles user messages with tool_result blocks", () => {
    const msg: SdkUserMessage = {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "result data" }],
      },
    };

    const result = mapSdkMessage(msg);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.kind).toBe("tool_call_end");
    expect(result.isDone).toBe(false);
  });

  test("ignores unknown message types", () => {
    const msg = { type: "unknown_type" };

    const result = mapSdkMessage(msg);

    expect(result.events).toHaveLength(0);
    expect(result.isDone).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createMessageMapper
// ---------------------------------------------------------------------------

describe("createMessageMapper", () => {
  test("routes stream_event to StreamEventMapper for text_delta", () => {
    const mapper = createMessageMapper();

    const msg: SdkStreamEventMessage = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      },
    };

    const result = mapper.map(msg);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({ kind: "text_delta", delta: "Hello" });
    expect(result.isDone).toBe(false);
  });

  test("routes stream_event to StreamEventMapper for tool_call_start", () => {
    const mapper = createMessageMapper();

    const msg: SdkStreamEventMessage = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call-1", name: "search" },
      },
    };

    const result = mapper.map(msg);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      kind: "tool_call_start",
      toolName: "search",
      callId: "call-1",
    });
  });

  test("routes stream_event to StreamEventMapper for tool_call_delta", () => {
    const mapper = createMessageMapper();

    // Register the tool call first
    mapper.map({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call-1", name: "write" },
      },
    });

    // Then receive delta
    const result = mapper.map({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      },
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      kind: "tool_call_delta",
      callId: "call-1",
      delta: '{"path":',
    });
  });

  test("returns empty events for stream_event with undefined event", () => {
    const mapper = createMessageMapper();

    const msg: SdkStreamEventMessage = {
      type: "stream_event",
    };

    const result = mapper.map(msg);

    expect(result.events).toHaveLength(0);
    expect(result.isDone).toBe(false);
  });

  test("suppresses assistant message after stream_event (duplicate prevention)", () => {
    const mapper = createMessageMapper();

    // First: stream events deliver the content
    mapper.map({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello!" },
      },
    });

    // Then: complete assistant message arrives (duplicate)
    const assistantMsg: SdkAssistantMessage = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello!" }],
      },
    };

    const result = mapper.map(assistantMsg);

    // Should be suppressed — empty events
    expect(result.events).toHaveLength(0);
    expect(result.isDone).toBe(false);
  });

  test("does not suppress assistant message when no stream_event preceded it", () => {
    const mapper = createMessageMapper();

    const assistantMsg: SdkAssistantMessage = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello!" }],
      },
    };

    const result = mapper.map(assistantMsg);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({ kind: "text_delta", delta: "Hello!" });
  });

  test("passes through non-stream, non-assistant messages unchanged", () => {
    const mapper = createMessageMapper();

    const systemMsg: SdkSystemMessage = {
      type: "system",
      subtype: "init",
      session_id: "sess-123",
    };

    const result = mapper.map(systemMsg);

    expect(result.sessionId).toBe("sess-123");
    expect(result.events).toHaveLength(0);
    expect(result.isDone).toBe(false);
  });

  test("passes through result messages unchanged", () => {
    const mapper = createMessageMapper();

    const resultMsg: SdkResultMessage = {
      type: "result",
      subtype: "success",
      result: "Done",
      num_turns: 1,
      duration_ms: 100,
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const result = mapper.map(resultMsg);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.kind).toBe("done");
    expect(result.isDone).toBe(true);
  });

  test("resets streaming flag after suppressed assistant, allowing next assistant through", () => {
    const mapper = createMessageMapper();

    // Stream event activates streaming
    mapper.map({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "First" },
      },
    });

    // First assistant is suppressed
    mapper.map({
      type: "assistant",
      message: { content: [{ type: "text", text: "First" }] },
    } as SdkAssistantMessage);

    // Second assistant (no preceding stream_event) should go through
    const result = mapper.map({
      type: "assistant",
      message: { content: [{ type: "text", text: "Second" }] },
    } as SdkAssistantMessage);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({ kind: "text_delta", delta: "Second" });
  });

  test("handles interleaved stream and non-stream turns", () => {
    const mapper = createMessageMapper();

    // Turn 1: streamed
    mapper.map({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "A" } },
    });
    const suppressed = mapper.map({
      type: "assistant",
      message: { content: [{ type: "text", text: "A" }] },
    } as SdkAssistantMessage);
    expect(suppressed.events).toHaveLength(0);

    // User message in between
    const userResult = mapper.map({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] },
    } as SdkUserMessage);
    expect(userResult.events).toHaveLength(1);

    // Turn 2: not streamed — assistant should pass through
    const passThrough = mapper.map({
      type: "assistant",
      message: { content: [{ type: "text", text: "B" }] },
    } as SdkAssistantMessage);
    expect(passThrough.events).toHaveLength(1);
    expect(passThrough.events[0]).toEqual({ kind: "text_delta", delta: "B" });
  });
});
