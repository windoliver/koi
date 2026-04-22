import { describe, expect, it } from "bun:test";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import { defaultRepairStrategy, formatErrors } from "./repair.js";
import type { ValidationError } from "./types.js";

const baseRequest = (): ModelRequest => ({
  messages: [{ senderId: "user", content: [{ kind: "text", text: "hello" }], timestamp: 1 }],
});

const baseResponse = (): ModelResponse => ({ content: "bad output", model: "test" });

const errors: ValidationError[] = [{ validator: "json", message: "not valid JSON" }];

describe("formatErrors", () => {
  it("formats a single error", () => {
    const result = formatErrors([{ validator: "v1", message: "bad" }]);
    expect(result).toBe("[v1] bad");
  });

  it("includes path when present", () => {
    const result = formatErrors([{ validator: "v1", message: "bad", path: "$.foo" }]);
    expect(result).toBe("[v1] at $.foo bad");
  });

  it("joins multiple errors with newlines", () => {
    const result = formatErrors([
      { validator: "v1", message: "e1" },
      { validator: "v2", message: "e2" },
    ]);
    expect(result).toContain("[v1] e1");
    expect(result).toContain("[v2] e2");
  });
});

describe("defaultRepairStrategy", () => {
  it("appends feedback message on first retry (feedbackMessageId undefined)", () => {
    const { request, feedbackMessageId } = defaultRepairStrategy.buildRetryRequest(
      baseRequest(),
      errors,
      { attempt: 1, response: baseResponse(), feedbackMessageId: undefined },
    );
    expect(request.messages).toHaveLength(2); // original + feedback
    expect(feedbackMessageId).toBeDefined();
  });

  it("preserves original user messages unchanged", () => {
    const original = baseRequest();
    const { request } = defaultRepairStrategy.buildRetryRequest(original, errors, {
      attempt: 1,
      response: baseResponse(),
      feedbackMessageId: undefined,
    });
    expect(request.messages[0]).toBe(original.messages[0]);
  });

  it("replaces prior feedback on second retry (single slot)", () => {
    const req1 = baseRequest();
    const { request: req2, feedbackMessageId: id1 } = defaultRepairStrategy.buildRetryRequest(
      req1,
      errors,
      { attempt: 1, response: baseResponse(), feedbackMessageId: undefined },
    );
    const { request: req3, feedbackMessageId: id2 } = defaultRepairStrategy.buildRetryRequest(
      req2,
      [{ validator: "json", message: "still not JSON" }],
      { attempt: 2, response: baseResponse(), feedbackMessageId: id1 },
    );
    // Length must not grow — second retry replaces, not appends
    expect(req3.messages).toHaveLength(req2.messages.length);
    // Latest error must appear in feedback
    const feedback = req3.messages[req3.messages.length - 1];
    const text = feedback?.content[0];
    expect(text?.kind === "text" && text.text).toContain("still not JSON");
    void id2; // used for type check only
  });

  it("falls back to append when feedbackMessageId points out-of-range", () => {
    const req = baseRequest();
    const { request } = defaultRepairStrategy.buildRetryRequest(req, errors, {
      attempt: 2,
      response: baseResponse(),
      feedbackMessageId: "999",
    });
    expect(request.messages.length).toBeGreaterThan(req.messages.length);
  });

  it("original request is not mutated", () => {
    const original = baseRequest();
    const originalLength = original.messages.length;
    defaultRepairStrategy.buildRetryRequest(original, errors, {
      attempt: 1,
      response: baseResponse(),
      feedbackMessageId: undefined,
    });
    expect(original.messages).toHaveLength(originalLength);
  });
});
