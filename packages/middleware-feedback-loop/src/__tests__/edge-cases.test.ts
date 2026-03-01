import { describe, expect, test } from "bun:test";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import {
  createAsyncValidator,
  createFailingValidator,
  createMockTurnContext,
  createMockValidator,
  createSpyModelHandler,
  createThrowingValidator,
} from "@koi/test-utils";
import { createFeedbackLoopMiddleware } from "../feedback-loop.js";

const ctx = createMockTurnContext();

const baseRequest: ModelRequest = {
  messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
};

describe("edge cases", () => {
  test("empty validators -> pass-through with zero overhead", async () => {
    const spy = createSpyModelHandler({ content: "fast", model: "m" });
    const { middleware: mw } = createFeedbackLoopMiddleware({ validators: [] });

    const result = await mw.wrapModelCall?.(ctx, baseRequest, spy.handler);
    expect(result).toBeDefined();
    expect(result?.content).toBe("fast");
    expect(spy.calls).toHaveLength(1);
  });

  test("empty gates -> no gate check", async () => {
    const spy = createSpyModelHandler({ content: "ok", model: "m" });
    const { middleware: mw } = createFeedbackLoopMiddleware({ gates: [] });

    const result = await mw.wrapModelCall?.(ctx, baseRequest, spy.handler);
    expect(result).toBeDefined();
    expect(result?.content).toBe("ok");
  });

  test("async validator awaited correctly", async () => {
    const spy = createSpyModelHandler({ content: "ok", model: "m" });
    const { middleware: mw } = createFeedbackLoopMiddleware({
      validators: [createAsyncValidator(10, { valid: true }, "slow-v")],
    });

    const result = await mw.wrapModelCall?.(ctx, baseRequest, spy.handler);
    expect(result).toBeDefined();
    expect(result?.content).toBe("ok");
  });

  test("validator that throws -> wrapped as non-retryable, immediate throw", async () => {
    const { middleware: mw } = createFeedbackLoopMiddleware({
      validators: [createThrowingValidator(new Error("validator crash"), "crasher")],
      retry: { validation: { maxAttempts: 5 } },
    });

    const spy = createSpyModelHandler({ content: "ok", model: "m" });

    try {
      await mw.wrapModelCall?.(ctx, baseRequest, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.message).toContain("non-retryable");
      }
    }
    // Only 1 attempt because thrown error is marked retryable: false
    expect(spy.calls).toHaveLength(1);
  });

  test("mixed results: some validators pass, some fail -> all errors collected", async () => {
    const { middleware: mw } = createFeedbackLoopMiddleware({
      validators: [
        createMockValidator("pass-1"),
        createFailingValidator([{ validator: "fail-1", message: "err1" }], "fail-1"),
        createMockValidator("pass-2"),
        createFailingValidator([{ validator: "fail-2", message: "err2" }], "fail-2"),
      ],
      retry: { validation: { maxAttempts: 1 } },
    });

    const spy = createSpyModelHandler({ content: "output", model: "m" });

    try {
      await mw.wrapModelCall?.(ctx, baseRequest, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        const errContext = e.context as Record<string, unknown>;
        const errors = errContext.errors as readonly Record<string, unknown>[];
        expect(errors).toHaveLength(2);
        expect(errors[0]?.validator).toBe("fail-1");
        expect(errors[1]?.validator).toBe("fail-2");
      }
    }
  });

  test("retryable: false on error -> immediate throw, no further retries", async () => {
    // let: counter for tracking
    let attempts = 0;
    const handler = async (): Promise<ModelResponse> => {
      attempts++;
      return { content: "bad", model: "m" };
    };

    const { middleware: mw } = createFeedbackLoopMiddleware({
      validators: [
        {
          name: "fatal-check",
          validate: () => ({
            valid: false as const,
            errors: [{ validator: "fatal-check", message: "fatal", retryable: false }],
          }),
        },
      ],
      retry: { validation: { maxAttempts: 10 } },
    });

    try {
      await mw.wrapModelCall?.(ctx, baseRequest, handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
    }
    expect(attempts).toBe(1);
  });

  test("transport error on first call, then succeeds on retry", async () => {
    // let: counter for tracking
    let calls = 0;
    const handler = async (): Promise<ModelResponse> => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return { content: "recovered", model: "m" };
    };

    const { middleware: mw } = createFeedbackLoopMiddleware({
      validators: [createMockValidator("v1")],
      retry: { transport: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } },
    });

    const result = await mw.wrapModelCall?.(ctx, baseRequest, handler);
    expect(result).toBeDefined();
    expect(result?.content).toBe("recovered");
    expect(calls).toBe(2);
  });

  test("gate throws -> wrapped as KoiRuntimeError", async () => {
    const spy = createSpyModelHandler({ content: "ok", model: "m" });
    const { middleware: mw } = createFeedbackLoopMiddleware({
      gates: [createThrowingValidator(new Error("gate crash"), "crash-gate")],
    });

    try {
      await mw.wrapModelCall?.(ctx, baseRequest, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("VALIDATION");
        expect(e.message).toContain("crash-gate");
      }
    }
  });

  test("validators and gates both present — validators run first", async () => {
    const order: string[] = [];
    const handler = async (): Promise<ModelResponse> => ({
      content: "ok",
      model: "m",
    });

    const { middleware: mw } = createFeedbackLoopMiddleware({
      validators: [
        {
          name: "validator",
          validate: () => {
            order.push("validator");
            return { valid: true as const };
          },
        },
      ],
      gates: [
        {
          name: "gate",
          validate: () => {
            order.push("gate");
            return { valid: true as const };
          },
        },
      ],
    });

    await mw.wrapModelCall?.(ctx, baseRequest, handler);
    expect(order).toEqual(["validator", "gate"]);
  });
});
