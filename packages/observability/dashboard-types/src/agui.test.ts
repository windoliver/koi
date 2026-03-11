/**
 * AG-UI event validation tests.
 *
 * Tests parseAguiEvent for every event type — valid events pass,
 * missing required fields return null.
 */

import { describe, expect, test } from "bun:test";
import { parseAguiEvent } from "./agui.js";
import type { SSEEvent } from "./sse-parser.js";

/** Helper to create an SSE event from a JSON payload. */
function sse(data: unknown): SSEEvent {
  return {
    event: "message",
    data: JSON.stringify(data),
    id: "",
    retry: undefined,
  };
}

describe("parseAguiEvent", () => {
  // ─── Valid Events ───────────────────────────────────────────────────

  test("parses RUN_STARTED", () => {
    const result = parseAguiEvent(sse({ type: "RUN_STARTED", threadId: "t1", runId: "r1" }));
    expect(result).not.toBeNull();
    expect(result?.type).toBe("RUN_STARTED");
  });

  test("parses RUN_FINISHED", () => {
    const result = parseAguiEvent(sse({ type: "RUN_FINISHED", threadId: "t1", runId: "r1" }));
    expect(result).not.toBeNull();
    expect(result?.type).toBe("RUN_FINISHED");
  });

  test("parses RUN_ERROR", () => {
    const result = parseAguiEvent(sse({ type: "RUN_ERROR", message: "Model failed" }));
    expect(result).not.toBeNull();
    if (result?.type === "RUN_ERROR") {
      expect(result.message).toBe("Model failed");
    }
  });

  test("parses STATE_SNAPSHOT", () => {
    const result = parseAguiEvent(sse({ type: "STATE_SNAPSHOT", snapshot: { key: "val" } }));
    expect(result).not.toBeNull();
    expect(result?.type).toBe("STATE_SNAPSHOT");
  });

  test("parses STATE_DELTA", () => {
    const result = parseAguiEvent(sse({ type: "STATE_DELTA", delta: [1, 2] }));
    expect(result).not.toBeNull();
    expect(result?.type).toBe("STATE_DELTA");
  });

  test("parses STEP_STARTED", () => {
    const result = parseAguiEvent(sse({ type: "STEP_STARTED", stepName: "plan" }));
    expect(result).not.toBeNull();
    if (result?.type === "STEP_STARTED") {
      expect(result.stepName).toBe("plan");
    }
  });

  test("parses STEP_FINISHED", () => {
    const result = parseAguiEvent(sse({ type: "STEP_FINISHED", stepName: "plan" }));
    expect(result).not.toBeNull();
    expect(result?.type).toBe("STEP_FINISHED");
  });

  test("parses TEXT_MESSAGE_START", () => {
    const result = parseAguiEvent(
      sse({ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" }),
    );
    expect(result).not.toBeNull();
    if (result?.type === "TEXT_MESSAGE_START") {
      expect(result.messageId).toBe("m1");
      expect(result.role).toBe("assistant");
    }
  });

  test("parses TEXT_MESSAGE_CONTENT", () => {
    const result = parseAguiEvent(
      sse({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hello" }),
    );
    expect(result).not.toBeNull();
    if (result?.type === "TEXT_MESSAGE_CONTENT") {
      expect(result.delta).toBe("Hello");
    }
  });

  test("parses TEXT_MESSAGE_END", () => {
    const result = parseAguiEvent(sse({ type: "TEXT_MESSAGE_END", messageId: "m1" }));
    expect(result).not.toBeNull();
    expect(result?.type).toBe("TEXT_MESSAGE_END");
  });

  test("parses REASONING_MESSAGE_START", () => {
    const result = parseAguiEvent(sse({ type: "REASONING_MESSAGE_START", messageId: "r1" }));
    expect(result).not.toBeNull();
    expect(result?.type).toBe("REASONING_MESSAGE_START");
  });

  test("parses REASONING_MESSAGE_CONTENT", () => {
    const result = parseAguiEvent(
      sse({ type: "REASONING_MESSAGE_CONTENT", messageId: "r1", delta: "thinking..." }),
    );
    expect(result).not.toBeNull();
    if (result?.type === "REASONING_MESSAGE_CONTENT") {
      expect(result.delta).toBe("thinking...");
    }
  });

  test("parses REASONING_MESSAGE_END", () => {
    const result = parseAguiEvent(sse({ type: "REASONING_MESSAGE_END", messageId: "r1" }));
    expect(result).not.toBeNull();
    expect(result?.type).toBe("REASONING_MESSAGE_END");
  });

  test("parses TOOL_CALL_START", () => {
    const result = parseAguiEvent(
      sse({ type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "search" }),
    );
    expect(result).not.toBeNull();
    if (result?.type === "TOOL_CALL_START") {
      expect(result.toolCallName).toBe("search");
    }
  });

  test("parses TOOL_CALL_ARGS", () => {
    const result = parseAguiEvent(
      sse({ type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: '{"q":"test"}' }),
    );
    expect(result).not.toBeNull();
    if (result?.type === "TOOL_CALL_ARGS") {
      expect(result.delta).toBe('{"q":"test"}');
    }
  });

  test("parses TOOL_CALL_END", () => {
    const result = parseAguiEvent(sse({ type: "TOOL_CALL_END", toolCallId: "tc1" }));
    expect(result).not.toBeNull();
    expect(result?.type).toBe("TOOL_CALL_END");
  });

  test("parses TOOL_CALL_RESULT", () => {
    const result = parseAguiEvent(
      sse({ type: "TOOL_CALL_RESULT", toolCallId: "tc1", result: '["r1"]' }),
    );
    expect(result).not.toBeNull();
    if (result?.type === "TOOL_CALL_RESULT") {
      expect(result.result).toBe('["r1"]');
    }
  });

  test("parses CUSTOM event", () => {
    const result = parseAguiEvent(sse({ type: "CUSTOM", name: "metrics", value: { tokens: 42 } }));
    expect(result).not.toBeNull();
    if (result?.type === "CUSTOM") {
      expect(result.name).toBe("metrics");
    }
  });

  // ─── Invalid Events (missing required fields) ─────────────────────

  test("rejects RUN_STARTED without threadId", () => {
    expect(parseAguiEvent(sse({ type: "RUN_STARTED", runId: "r1" }))).toBeNull();
  });

  test("rejects RUN_STARTED without runId", () => {
    expect(parseAguiEvent(sse({ type: "RUN_STARTED", threadId: "t1" }))).toBeNull();
  });

  test("rejects RUN_ERROR without message", () => {
    expect(parseAguiEvent(sse({ type: "RUN_ERROR" }))).toBeNull();
  });

  test("rejects STEP_STARTED without stepName", () => {
    expect(parseAguiEvent(sse({ type: "STEP_STARTED" }))).toBeNull();
  });

  test("rejects TEXT_MESSAGE_START without messageId", () => {
    expect(parseAguiEvent(sse({ type: "TEXT_MESSAGE_START", role: "assistant" }))).toBeNull();
  });

  test("rejects TEXT_MESSAGE_START without role", () => {
    expect(parseAguiEvent(sse({ type: "TEXT_MESSAGE_START", messageId: "m1" }))).toBeNull();
  });

  test("rejects TEXT_MESSAGE_CONTENT without delta", () => {
    expect(parseAguiEvent(sse({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1" }))).toBeNull();
  });

  test("rejects TEXT_MESSAGE_CONTENT without messageId", () => {
    expect(parseAguiEvent(sse({ type: "TEXT_MESSAGE_CONTENT", delta: "hi" }))).toBeNull();
  });

  test("rejects TEXT_MESSAGE_END without messageId", () => {
    expect(parseAguiEvent(sse({ type: "TEXT_MESSAGE_END" }))).toBeNull();
  });

  test("rejects REASONING_MESSAGE_CONTENT without delta", () => {
    expect(parseAguiEvent(sse({ type: "REASONING_MESSAGE_CONTENT", messageId: "r1" }))).toBeNull();
  });

  test("rejects TOOL_CALL_START without toolCallName", () => {
    expect(parseAguiEvent(sse({ type: "TOOL_CALL_START", toolCallId: "tc1" }))).toBeNull();
  });

  test("rejects TOOL_CALL_START without toolCallId", () => {
    expect(parseAguiEvent(sse({ type: "TOOL_CALL_START", toolCallName: "search" }))).toBeNull();
  });

  test("rejects TOOL_CALL_ARGS without delta", () => {
    expect(parseAguiEvent(sse({ type: "TOOL_CALL_ARGS", toolCallId: "tc1" }))).toBeNull();
  });

  test("rejects TOOL_CALL_END without toolCallId", () => {
    expect(parseAguiEvent(sse({ type: "TOOL_CALL_END" }))).toBeNull();
  });

  test("rejects TOOL_CALL_RESULT without result", () => {
    expect(parseAguiEvent(sse({ type: "TOOL_CALL_RESULT", toolCallId: "tc1" }))).toBeNull();
  });

  test("rejects CUSTOM without name", () => {
    expect(parseAguiEvent(sse({ type: "CUSTOM", value: {} }))).toBeNull();
  });

  // ─── Malformed Input ──────────────────────────────────────────────

  test("rejects non-JSON data", () => {
    const event: SSEEvent = {
      event: "message",
      data: "not-json",
      id: "",
      retry: undefined,
    };
    expect(parseAguiEvent(event)).toBeNull();
  });

  test("rejects non-object data", () => {
    expect(parseAguiEvent(sse("string-value"))).toBeNull();
  });

  test("rejects null data", () => {
    expect(parseAguiEvent(sse(null))).toBeNull();
  });

  test("rejects array data", () => {
    expect(parseAguiEvent(sse([1, 2, 3]))).toBeNull();
  });

  test("rejects missing type field", () => {
    expect(parseAguiEvent(sse({ threadId: "t1", runId: "r1" }))).toBeNull();
  });

  test("rejects non-string type field", () => {
    expect(parseAguiEvent(sse({ type: 42 }))).toBeNull();
  });

  test("rejects unknown event type", () => {
    expect(parseAguiEvent(sse({ type: "UNKNOWN_EVENT" }))).toBeNull();
  });

  test("rejects numeric field where string expected", () => {
    expect(
      parseAguiEvent(sse({ type: "TEXT_MESSAGE_CONTENT", messageId: 123, delta: "hi" })),
    ).toBeNull();
  });
});
