import { describe, expect, test } from "bun:test";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import { defaultRepairStrategy, formatErrors } from "./repair.js";
import type { ValidationError } from "./types.js";

const baseRequest: ModelRequest = {
  messages: [
    {
      senderId: "user-1",
      timestamp: 1000,
      content: [{ kind: "text", text: "Hello" }],
    },
  ],
  model: "test-model",
};

const baseResponse: ModelResponse = {
  content: "bad output",
  model: "test-model",
};

describe("formatErrors", () => {
  test("formats single error", () => {
    const errors: readonly ValidationError[] = [
      { validator: "schema", message: "missing field 'name'" },
    ];
    const result = formatErrors(errors);
    expect(result).toBe("[schema] missing field 'name'");
  });

  test("includes path when present", () => {
    const errors: readonly ValidationError[] = [
      { validator: "schema", message: "expected string", path: "$.data.name" },
    ];
    const result = formatErrors(errors);
    expect(result).toBe("[schema] at $.data.name expected string");
  });

  test("formats multiple errors with newlines", () => {
    const errors: readonly ValidationError[] = [
      { validator: "v1", message: "err1" },
      { validator: "v2", message: "err2" },
    ];
    const result = formatErrors(errors);
    expect(result).toBe("[v1] err1\n[v2] err2");
  });

  test("handles empty errors array", () => {
    expect(formatErrors([])).toBe("");
  });
});

describe("defaultRepairStrategy", () => {
  test("appends assistant response and error feedback to messages", async () => {
    const errors: readonly ValidationError[] = [{ validator: "schema", message: "invalid JSON" }];
    const result = await defaultRepairStrategy.buildRetryRequest(
      baseRequest,
      baseResponse,
      errors,
      1,
    );

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]?.senderId).toBe("user-1");

    // Assistant response message
    const assistant = result.messages[1];
    expect(assistant?.senderId).toBe("assistant");
    expect(assistant?.content[0]?.kind).toBe("text");
    if (assistant?.content[0]?.kind === "text") {
      expect(assistant.content[0].text).toBe("bad output");
    }

    // Error feedback message
    const feedback = result.messages[2];
    expect(feedback?.senderId).toBe("system:feedback-loop");
    if (feedback?.content[0]?.kind === "text") {
      expect(feedback.content[0].text).toContain("validation errors");
      expect(feedback.content[0].text).toContain("[schema] invalid JSON");
    }
  });

  test("preserves original request properties", async () => {
    const errors: readonly ValidationError[] = [{ validator: "v1", message: "bad" }];
    const result = await defaultRepairStrategy.buildRetryRequest(
      baseRequest,
      baseResponse,
      errors,
      1,
    );
    expect(result.model).toBe("test-model");
  });

  test("does not mutate original request", async () => {
    const errors: readonly ValidationError[] = [{ validator: "v1", message: "bad" }];
    const originalLength = baseRequest.messages.length;
    await defaultRepairStrategy.buildRetryRequest(baseRequest, baseResponse, errors, 1);
    expect(baseRequest.messages).toHaveLength(originalLength);
  });
});
