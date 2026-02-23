import { describe, expect, test } from "bun:test";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import { createFeedbackLoopMiddleware } from "../feedback-loop.js";

const ctx = createMockTurnContext();

const baseRequest: ModelRequest = {
  messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
};

describe("retry exhaustion", () => {
  test("validation fails N times -> error includes attempt count and all errors", async () => {
    const mw = createFeedbackLoopMiddleware({
      validators: [
        {
          name: "strict",
          validate: () => ({
            valid: false as const,
            errors: [{ validator: "strict", message: "always fails" }],
          }),
        },
      ],
      retry: { validation: { maxAttempts: 3 } },
    });

    const spy = createSpyModelHandler({ content: "bad", model: "m" });

    try {
      await mw.wrapModelCall?.(ctx, baseRequest, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("VALIDATION");
        expect(e.message).toContain("3 attempts");
        const errContext = e.context as Record<string, unknown>;
        expect(errContext.attempts).toBe(3);
        const errors = errContext.errors as readonly Record<string, unknown>[];
        // 3 attempts × 1 error each = 3 accumulated errors
        expect(errors).toHaveLength(3);
      }
    }
    // Handler called 3 times (initial + 2 retries = 3)
    expect(spy.calls).toHaveLength(3);
  });

  test("transport error with backoff -> re-throws last error", async () => {
    const mw = createFeedbackLoopMiddleware({
      validators: [{ name: "v1", validate: () => ({ valid: true as const }) }],
      retry: { transport: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } },
    });

    const transportError = new Error("ECONNRESET");
    // let: attempt counter
    let attempts = 0;
    const handler = async (): Promise<ModelResponse> => {
      attempts++;
      throw transportError;
    };

    try {
      await mw.wrapModelCall?.(ctx, baseRequest, handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBe(transportError);
    }
    expect(attempts).toBe(2);
  });

  test("mixed: transport then validation errors tracked separately", async () => {
    const mw = createFeedbackLoopMiddleware({
      validators: [
        {
          name: "v1",
          validate: (output: unknown) =>
            output === "good"
              ? { valid: true as const }
              : { valid: false as const, errors: [{ validator: "v1", message: "bad" }] },
        },
      ],
      retry: {
        validation: { maxAttempts: 2 },
        transport: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      },
    });

    // let: call counter for interleaving error types
    let call = 0;
    const handler = async (): Promise<ModelResponse> => {
      call++;
      if (call === 1) throw new Error("network");
      if (call === 2) return { content: "bad", model: "m" };
      return { content: "good", model: "m" };
    };

    const result = await mw.wrapModelCall?.(ctx, baseRequest, handler);
    expect(result).toBeDefined();
    expect(result?.content).toBe("good");
    expect(call).toBe(3);
  });

  test("single attempt config (maxAttempts: 1) fails immediately", async () => {
    const mw = createFeedbackLoopMiddleware({
      validators: [
        {
          name: "v1",
          validate: () => ({
            valid: false as const,
            errors: [{ validator: "v1", message: "fail" }],
          }),
        },
      ],
      retry: { validation: { maxAttempts: 1 } },
    });

    const spy = createSpyModelHandler({ content: "bad", model: "m" });

    try {
      await mw.wrapModelCall?.(ctx, baseRequest, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.message).toContain("1 attempt");
      }
    }
    expect(spy.calls).toHaveLength(1);
  });
});
