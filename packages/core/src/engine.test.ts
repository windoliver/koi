/**
 * Exhaustiveness and shape tests for EngineEvent and ChannelStatus types.
 */

import { describe, expect, test } from "bun:test";
import type { ChannelStatus, ChannelStatusKind, EngineEvent } from "./index.js";
import { toolCallId } from "./index.js";

// ---------------------------------------------------------------------------
// EngineEvent exhaustiveness (compile-time + runtime)
// ---------------------------------------------------------------------------

/**
 * Compile-time exhaustiveness check: if a new variant is added to EngineEvent
 * but this function is not updated, TypeScript will error on the `never` branch.
 */
function engineEventLabel(event: EngineEvent): string {
  switch (event.kind) {
    case "turn_start":
      return "start";
    case "text_delta":
      return "delta";
    case "tool_call_start":
      return "tcs";
    case "tool_call_delta":
      return "tcd";
    case "tool_call_end":
      return "tce";
    case "turn_end":
      return "end";
    case "done":
      return "done";
    case "custom":
      return "custom";
    case "discovery:miss":
      return "miss";
    default: {
      const _exhaustive: never = event;
      return String(_exhaustive);
    }
  }
}

describe("EngineEvent exhaustiveness", () => {
  test("turn_start variant is handled", () => {
    const event: EngineEvent = { kind: "turn_start", turnIndex: 0 };
    expect(engineEventLabel(event)).toBe("start");
  });

  test("text_delta variant is handled", () => {
    const event: EngineEvent = { kind: "text_delta", delta: "hi" };
    expect(engineEventLabel(event)).toBe("delta");
  });

  test("tool_call_start variant is handled", () => {
    const event: EngineEvent = {
      kind: "tool_call_start",
      toolName: "calc",
      callId: toolCallId("c1"),
      args: {},
    };
    expect(engineEventLabel(event)).toBe("tcs");
  });

  test("tool_call_delta variant is handled", () => {
    const event: EngineEvent = { kind: "tool_call_delta", callId: toolCallId("c1"), delta: "{}" };
    expect(engineEventLabel(event)).toBe("tcd");
  });

  test("tool_call_end variant is handled", () => {
    const event: EngineEvent = { kind: "tool_call_end", callId: toolCallId("c1"), result: 42 };
    expect(engineEventLabel(event)).toBe("tce");
  });

  test("turn_end variant is handled", () => {
    const event: EngineEvent = { kind: "turn_end", turnIndex: 0 };
    expect(engineEventLabel(event)).toBe("end");
  });

  test("done variant is handled", () => {
    const event: EngineEvent = {
      kind: "done",
      output: {
        content: [],
        stopReason: "completed",
        metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
      },
    };
    expect(engineEventLabel(event)).toBe("done");
  });

  test("custom variant is handled", () => {
    const event: EngineEvent = { kind: "custom", type: "x", data: null };
    expect(engineEventLabel(event)).toBe("custom");
  });

  test("discovery:miss variant is handled", () => {
    const event: EngineEvent = {
      kind: "discovery:miss",
      resolverSource: "forge",
      timestamp: Date.now(),
    };
    expect(engineEventLabel(event)).toBe("miss");
  });
});

// ---------------------------------------------------------------------------
// ChannelStatus shape tests
// ---------------------------------------------------------------------------

describe("ChannelStatus shape", () => {
  test("processing status has required fields", () => {
    const status: ChannelStatus = { kind: "processing", turnIndex: 0 };
    expect(status.kind).toBe("processing");
    expect(status.turnIndex).toBe(0);
  });

  test("idle status with optional fields", () => {
    const status: ChannelStatus = {
      kind: "idle",
      turnIndex: 1,
      messageRef: "msg-123",
      detail: "done thinking",
      metadata: { source: "test" },
    };
    expect(status.kind).toBe("idle");
    expect(status.turnIndex).toBe(1);
    expect(status.messageRef).toBe("msg-123");
    expect(status.detail).toBe("done thinking");
    expect(status.metadata).toEqual({ source: "test" });
  });

  test("error status is valid", () => {
    const status: ChannelStatus = { kind: "error", turnIndex: 0 };
    expect(status.kind).toBe("error");
  });

  test("ChannelStatusKind type covers all values", () => {
    const kinds: readonly ChannelStatusKind[] = ["processing", "idle", "error"];
    expect(kinds).toHaveLength(3);
  });
});
