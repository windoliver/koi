/**
 * Exhaustiveness and shape tests for ModelAdapter, ModelContentBlock,
 * and ModelStopReason types.
 */

import { describe, expect, test } from "bun:test";
import type {
  ModelAdapter,
  ModelCapabilities,
  ModelContentBlock,
  ModelResponse,
  ModelStopReason,
} from "./index.js";
import { toolCallId } from "./index.js";

// ---------------------------------------------------------------------------
// ModelStopReason exhaustiveness (compile-time + runtime)
// ---------------------------------------------------------------------------

function stopReasonLabel(reason: ModelStopReason): string {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_use":
      return "tool_use";
    case "error":
      return "error";
    case "hook_blocked":
      return "hook_blocked";
    default: {
      const _exhaustive: never = reason;
      return String(_exhaustive);
    }
  }
}

describe("ModelStopReason exhaustiveness", () => {
  test("stop", () => {
    expect(stopReasonLabel("stop")).toBe("stop");
  });

  test("length", () => {
    expect(stopReasonLabel("length")).toBe("length");
  });

  test("tool_use", () => {
    expect(stopReasonLabel("tool_use")).toBe("tool_use");
  });

  test("error", () => {
    expect(stopReasonLabel("error")).toBe("error");
  });

  test("hook_blocked", () => {
    expect(stopReasonLabel("hook_blocked")).toBe("hook_blocked");
  });
});

// ---------------------------------------------------------------------------
// ModelContentBlock exhaustiveness (compile-time + runtime)
// ---------------------------------------------------------------------------

function contentBlockLabel(block: ModelContentBlock): string {
  switch (block.kind) {
    case "text":
      return "text";
    case "thinking":
      return "thinking";
    case "tool_call":
      return "tool_call";
    default: {
      const _exhaustive: never = block;
      return String(_exhaustive);
    }
  }
}

describe("ModelContentBlock exhaustiveness", () => {
  test("text block", () => {
    const block: ModelContentBlock = { kind: "text", text: "hello" };
    expect(contentBlockLabel(block)).toBe("text");
  });

  test("thinking block", () => {
    const block: ModelContentBlock = { kind: "thinking", text: "hmm" };
    expect(contentBlockLabel(block)).toBe("thinking");
  });

  test("thinking block with signature", () => {
    const block: ModelContentBlock = {
      kind: "thinking",
      text: "hmm",
      signature: "opaque-token",
    };
    expect(contentBlockLabel(block)).toBe("thinking");
    expect(block.signature).toBe("opaque-token");
  });

  test("tool_call block", () => {
    const block: ModelContentBlock = {
      kind: "tool_call",
      id: toolCallId("call-1"),
      name: "search",
      arguments: { query: "test" },
    };
    expect(contentBlockLabel(block)).toBe("tool_call");
  });
});

// ---------------------------------------------------------------------------
// ModelAdapter shape
// ---------------------------------------------------------------------------

describe("ModelAdapter shape", () => {
  test("has all required fields", () => {
    const capabilities: ModelCapabilities = {
      streaming: true,
      functionCalling: true,
      vision: false,
      jsonMode: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 4096,
    };

    const adapter: ModelAdapter = {
      id: "test-adapter",
      provider: "test",
      capabilities,
      complete: async () => ({ content: "hi", model: "test-model" }),
      stream: async function* () {
        yield { kind: "done", response: { content: "hi", model: "test-model" } };
      },
    };

    expect(adapter.id).toBe("test-adapter");
    expect(adapter.provider).toBe("test");
    expect(adapter.capabilities.streaming).toBe(true);
    expect(typeof adapter.complete).toBe("function");
    expect(typeof adapter.stream).toBe("function");
    expect(adapter.dispose).toBeUndefined();
  });

  test("optional dispose is callable", () => {
    const capabilities: ModelCapabilities = {
      streaming: true,
      functionCalling: false,
      vision: false,
      jsonMode: false,
      maxContextTokens: 8000,
      maxOutputTokens: 2048,
    };

    const adapter: ModelAdapter = {
      id: "disposable",
      provider: "test",
      capabilities,
      complete: async () => ({ content: "", model: "m" }),
      stream: async function* () {
        yield { kind: "done", response: { content: "", model: "m" } };
      },
      dispose: async () => {},
    };

    expect(typeof adapter.dispose).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Enriched ModelResponse shape
// ---------------------------------------------------------------------------

describe("ModelResponse enriched fields", () => {
  test("accepts all new optional fields", () => {
    const response: ModelResponse = {
      content: "hello",
      model: "test-model",
      stopReason: "stop",
      responseId: "resp-123",
      richContent: [
        { kind: "text", text: "hello" },
        { kind: "tool_call", id: toolCallId("c1"), name: "search", arguments: {} },
      ],
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      },
    };

    expect(response.stopReason).toBe("stop");
    expect(response.responseId).toBe("resp-123");
    expect(response.richContent).toHaveLength(2);
    expect(response.usage?.cacheReadTokens).toBe(10);
    expect(response.usage?.cacheWriteTokens).toBe(5);
  });

  test("remains backward compatible without new fields", () => {
    const response: ModelResponse = {
      content: "hello",
      model: "test-model",
    };

    expect(response.stopReason).toBeUndefined();
    expect(response.responseId).toBeUndefined();
    expect(response.richContent).toBeUndefined();
  });
});
