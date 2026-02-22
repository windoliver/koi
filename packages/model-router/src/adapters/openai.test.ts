import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@koi/core";
import { fromOpenAIResponse, mapStatusToErrorCode, toOpenAIRequest } from "./openai.js";

describe("toOpenAIRequest", () => {
  test("transforms basic ModelRequest to OpenAI format", () => {
    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "Hello" }],
          senderId: "test-user",
          timestamp: 0,
        },
      ],
      model: "gpt-4o",
    };

    const result = toOpenAIRequest(request);

    expect(result.model).toBe("gpt-4o");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content).toBe("Hello");
  });

  test("includes temperature when provided", () => {
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "test" }], senderId: "test-user", timestamp: 0 },
      ],
      temperature: 0.7,
    };

    const result = toOpenAIRequest(request);
    expect(result.temperature).toBe(0.7);
  });

  test("includes max_tokens when provided", () => {
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "test" }], senderId: "test-user", timestamp: 0 },
      ],
      maxTokens: 1000,
    };

    const result = toOpenAIRequest(request);
    expect(result.max_tokens).toBe(1000);
  });

  test("defaults model to gpt-4o when not specified", () => {
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "test" }], senderId: "test-user", timestamp: 0 },
      ],
    };

    const result = toOpenAIRequest(request);
    expect(result.model).toBe("gpt-4o");
  });

  test("transforms multiple messages", () => {
    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "First message" }],
          senderId: "test-user",
          timestamp: 0,
        },
        {
          content: [{ kind: "text" as const, text: "Second message" }],
          senderId: "test-user",
          timestamp: 0,
        },
      ],
    };

    const result = toOpenAIRequest(request);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.content).toBe("First message");
    expect(result.messages[1]?.content).toBe("Second message");
  });
});

describe("fromOpenAIResponse", () => {
  test("extracts content from first choice", () => {
    const response = {
      id: "chatcmpl-123",
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          message: { role: "assistant", content: "Hello!" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };

    const result = fromOpenAIResponse(response);

    expect(result.content).toBe("Hello!");
    expect(result.model).toBe("gpt-4o-2024-05-13");
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
  });

  test("handles null content", () => {
    const response = {
      id: "chatcmpl-123",
      model: "gpt-4o",
      choices: [
        {
          message: { role: "assistant", content: null },
          finish_reason: "stop",
        },
      ],
    };

    const result = fromOpenAIResponse(response);
    expect(result.content).toBe("");
  });

  test("handles missing usage", () => {
    const response = {
      id: "chatcmpl-123",
      model: "gpt-4o",
      choices: [
        {
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
    };

    const result = fromOpenAIResponse(response);
    expect(result.usage).toBeUndefined();
  });

  test("handles empty choices", () => {
    const response = {
      id: "chatcmpl-123",
      model: "gpt-4o",
      choices: [],
    };

    const result = fromOpenAIResponse(response);
    expect(result.content).toBe("");
  });
});

describe("mapStatusToErrorCode", () => {
  test("401 → PERMISSION", () => {
    expect(mapStatusToErrorCode(401)).toBe("PERMISSION");
  });

  test("403 → PERMISSION", () => {
    expect(mapStatusToErrorCode(403)).toBe("PERMISSION");
  });

  test("404 → NOT_FOUND", () => {
    expect(mapStatusToErrorCode(404)).toBe("NOT_FOUND");
  });

  test("429 → RATE_LIMIT", () => {
    expect(mapStatusToErrorCode(429)).toBe("RATE_LIMIT");
  });

  test("408 → TIMEOUT", () => {
    expect(mapStatusToErrorCode(408)).toBe("TIMEOUT");
  });

  test("504 → TIMEOUT", () => {
    expect(mapStatusToErrorCode(504)).toBe("TIMEOUT");
  });

  test("500 → EXTERNAL", () => {
    expect(mapStatusToErrorCode(500)).toBe("EXTERNAL");
  });

  test("502 → EXTERNAL", () => {
    expect(mapStatusToErrorCode(502)).toBe("EXTERNAL");
  });

  test("503 → EXTERNAL", () => {
    expect(mapStatusToErrorCode(503)).toBe("EXTERNAL");
  });

  test("400 → EXTERNAL (default)", () => {
    expect(mapStatusToErrorCode(400)).toBe("EXTERNAL");
  });
});
