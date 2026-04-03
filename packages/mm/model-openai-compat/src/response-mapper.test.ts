/**
 * Response mapper tests — stop reason mapping, rich content assembly, cache usage.
 */

import { describe, expect, test } from "bun:test";
import { toolCallId } from "@koi/core";
import {
  buildModelResponse,
  createEmptyAccumulator,
  mapFinishReason,
  parseToolArguments,
} from "./response-mapper.js";

// ---------------------------------------------------------------------------
// mapFinishReason
// ---------------------------------------------------------------------------

describe("mapFinishReason", () => {
  test("null → stop", () => {
    expect(mapFinishReason(null)).toBe("stop");
  });

  test("stop → stop", () => {
    expect(mapFinishReason("stop")).toBe("stop");
  });

  test("end → stop", () => {
    expect(mapFinishReason("end")).toBe("stop");
  });

  test("length → length", () => {
    expect(mapFinishReason("length")).toBe("length");
  });

  test("tool_calls → tool_use", () => {
    expect(mapFinishReason("tool_calls")).toBe("tool_use");
  });

  test("function_call → tool_use", () => {
    expect(mapFinishReason("function_call")).toBe("tool_use");
  });

  test("content_filter → error", () => {
    expect(mapFinishReason("content_filter")).toBe("error");
  });

  test("unknown reason → error", () => {
    expect(mapFinishReason("something_weird")).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// parseToolArguments
// ---------------------------------------------------------------------------

describe("parseToolArguments", () => {
  test("empty string → ok with empty object", () => {
    const result = parseToolArguments("");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args).toEqual({});
  });

  test("valid JSON object → ok with parsed args", () => {
    const result = parseToolArguments('{"key":"value"}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args).toEqual({ key: "value" });
  });

  test("invalid JSON → not ok with raw string", () => {
    const result = parseToolArguments("not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.raw).toBe("not json");
  });

  test("JSON array → not ok with raw string", () => {
    const result = parseToolArguments("[1,2,3]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.raw).toBe("[1,2,3]");
  });

  test("truncated JSON → not ok with raw string", () => {
    const result = parseToolArguments('{"key":"val');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.raw).toBe('{"key":"val');
  });
});

// ---------------------------------------------------------------------------
// buildModelResponse
// ---------------------------------------------------------------------------

describe("buildModelResponse", () => {
  test("builds response with all fields", () => {
    const response = buildModelResponse({
      responseId: "resp-1",
      model: "test-model",
      textContent: "hello",
      richContent: [
        { kind: "text", text: "hello" },
        { kind: "tool_call", id: toolCallId("c1"), name: "search", arguments: { q: "test" } },
      ],
      stopReason: "tool_use",
      receivedFinishReason: true,
      receivedUsage: true,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
    });

    expect(response.content).toBe("hello");
    expect(response.model).toBe("test-model");
    expect(response.stopReason).toBe("tool_use");
    expect(response.responseId).toBe("resp-1");
    expect(response.richContent).toHaveLength(2);
    expect(response.usage?.inputTokens).toBe(100);
    expect(response.usage?.outputTokens).toBe(50);
    expect(response.usage?.cacheReadTokens).toBe(20);
    expect(response.usage?.cacheWriteTokens).toBeUndefined(); // 0 → omitted
  });

  test("omits richContent when empty", () => {
    const response = buildModelResponse({
      responseId: "resp-2",
      model: "m",
      textContent: "hi",
      richContent: [],
      stopReason: "stop",
      receivedFinishReason: true,
      receivedUsage: true,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    expect(response.richContent).toBeUndefined();
  });

  test("omits usage when no usage data was received", () => {
    const response = buildModelResponse({
      responseId: "resp-3",
      model: "m",
      textContent: "hi",
      richContent: [],
      stopReason: "stop",
      receivedFinishReason: true,
      receivedUsage: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    expect(response.usage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createEmptyAccumulator
// ---------------------------------------------------------------------------

describe("createEmptyAccumulator", () => {
  test("initializes with defaults", () => {
    const acc = createEmptyAccumulator("test-model");
    expect(acc.model).toBe("test-model");
    expect(acc.textContent).toBe("");
    expect(acc.richContent).toEqual([]);
    expect(acc.stopReason).toBe("stop");
    expect(acc.receivedFinishReason).toBe(false);
    expect(acc.receivedUsage).toBe(false);
    expect(acc.inputTokens).toBe(0);
    expect(acc.outputTokens).toBe(0);
    expect(acc.cacheReadTokens).toBe(0);
    expect(acc.cacheWriteTokens).toBe(0);
  });
});
