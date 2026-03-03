import { describe, expect, test } from "bun:test";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import {
  createFailingValidator,
  createMockTurnContext,
  createMockValidator,
  createSpyModelHandler,
} from "@koi/test-utils";
import { createFeedbackLoopMiddleware } from "../feedback-loop.js";
import type { ValidationError } from "../types.js";

const ctx = createMockTurnContext();

const baseRequest: ModelRequest = {
  messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
};

describe("wrapModelCall integration", () => {
  test("happy path: all validators pass, response returned unchanged", async () => {
    const spy = createSpyModelHandler({ content: "good output", model: "m" });
    const { middleware: mw } = createFeedbackLoopMiddleware({
      validators: [createMockValidator("v1"), createMockValidator("v2")],
    });

    const result = await mw.wrapModelCall?.(ctx, baseRequest, spy.handler);
    expect(result).toBeDefined();
    expect(result?.content).toBe("good output");
    expect(spy.calls).toHaveLength(1);
  });

  test("validation fails then succeeds on retry", async () => {
    // let: counter needed for retry tracking
    let callCount = 0;
    const handler = async (_req: ModelRequest): Promise<ModelResponse> => {
      callCount++;
      return { content: callCount === 1 ? "bad" : "good", model: "m" };
    };

    const { middleware: mw } = createFeedbackLoopMiddleware({
      validators: [
        {
          name: "check",
          validate: (output: unknown) =>
            output === "good"
              ? { valid: true as const }
              : {
                  valid: false as const,
                  errors: [{ validator: "check", message: "not good" }],
                },
        },
      ],
      retry: { validation: { maxAttempts: 3 } },
    });

    const result = await mw.wrapModelCall?.(ctx, baseRequest, handler);
    expect(result).toBeDefined();
    expect(result?.content).toBe("good");
    expect(callCount).toBe(2);
  });

  test("validators pass but gate fails -> throws", async () => {
    const spy = createSpyModelHandler({ content: "valid but bad quality", model: "m" });
    const { middleware: mw } = createFeedbackLoopMiddleware({
      validators: [createMockValidator("v1")],
      gates: [createFailingValidator([{ validator: "quality", message: "too low" }], "quality")],
    });

    try {
      await mw.wrapModelCall?.(ctx, baseRequest, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("VALIDATION");
        expect(e.message).toContain("quality");
      }
    }
  });

  test("custom RepairStrategy modifies retry request", async () => {
    const requests: ModelRequest[] = [];
    // let: counter for call tracking
    let callCount = 0;
    const handler = async (req: ModelRequest): Promise<ModelResponse> => {
      callCount++;
      requests.push(req);
      return { content: callCount === 1 ? "bad" : "good", model: "m" };
    };

    const { middleware: mw } = createFeedbackLoopMiddleware({
      validators: [
        {
          name: "check",
          validate: (output: unknown) =>
            output === "good"
              ? { valid: true as const }
              : { valid: false as const, errors: [{ validator: "check", message: "bad" }] },
        },
      ],
      repairStrategy: {
        buildRetryRequest: (orig, _resp, _errors, attempt) => ({
          ...orig,
          metadata: { retryAttempt: attempt },
        }),
      },
    });

    await mw.wrapModelCall?.(ctx, baseRequest, handler);
    expect(requests[1]?.metadata).toEqual({ retryAttempt: 1 });
  });

  test("onRetry callback fires with correct args", async () => {
    const retryCalls: Array<{ attempt: number; errors: readonly ValidationError[] }> = [];
    // let: counter for tracking
    let callCount = 0;
    const handler = async (): Promise<ModelResponse> => {
      callCount++;
      return { content: callCount === 1 ? "bad" : "good", model: "m" };
    };

    const { middleware: mw } = createFeedbackLoopMiddleware({
      validators: [
        {
          name: "v1",
          validate: (output: unknown) =>
            output === "good"
              ? { valid: true as const }
              : { valid: false as const, errors: [{ validator: "v1", message: "nope" }] },
        },
      ],
      onRetry: (attempt, errors) => retryCalls.push({ attempt, errors }),
    });

    await mw.wrapModelCall?.(ctx, baseRequest, handler);
    expect(retryCalls).toHaveLength(1);
    expect(retryCalls[0]?.attempt).toBe(1);
    expect(retryCalls[0]?.errors[0]?.message).toBe("nope");
  });

  test("onGateFail callback fires on gate failure", async () => {
    const gateFails: Array<{ name: string; errors: readonly ValidationError[] }> = [];
    const spy = createSpyModelHandler({ content: "ok", model: "m" });

    const { middleware: mw } = createFeedbackLoopMiddleware({
      gates: [createFailingValidator([{ validator: "g1", message: "bad" }], "g1")],
      onGateFail: (name, errors) => gateFails.push({ name, errors }),
    });

    try {
      await mw.wrapModelCall?.(ctx, baseRequest, spy.handler);
    } catch {
      // Expected
    }
    expect(gateFails).toHaveLength(1);
    expect(gateFails[0]?.name).toBe("g1");
  });

  test("no validators and no gates -> zero overhead pass-through", async () => {
    const spy = createSpyModelHandler({ content: "pass", model: "m" });
    const { middleware: mw } = createFeedbackLoopMiddleware({});

    const result = await mw.wrapModelCall?.(ctx, baseRequest, spy.handler);
    expect(result).toBeDefined();
    expect(result?.content).toBe("pass");
    expect(spy.calls).toHaveLength(1);
  });

  test("gates only (no validators) -> response passes through to gate", async () => {
    const spy = createSpyModelHandler({ content: "fine", model: "m" });
    const { middleware: mw } = createFeedbackLoopMiddleware({
      gates: [createMockValidator("g1")],
    });

    const result = await mw.wrapModelCall?.(ctx, baseRequest, spy.handler);
    expect(result).toBeDefined();
    expect(result?.content).toBe("fine");
  });
});
