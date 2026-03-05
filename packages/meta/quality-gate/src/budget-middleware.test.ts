/**
 * Unit tests for the budget middleware.
 */

import { describe, expect, test } from "bun:test";
import type { ModelResponse } from "@koi/core";
import { createMockTurnContext } from "@koi/test-utils";
import { createBudgetMiddleware } from "./budget-middleware.js";

function createMockNext(): (request: unknown) => Promise<ModelResponse> {
  return async () =>
    ({
      content: "ok",
      model: "test-model",
      usage: { inputTokens: 0, outputTokens: 0 },
    }) satisfies ModelResponse;
}

/** Extracts wrapModelCall from middleware, throwing if missing. */
function getWrap(
  mw: ReturnType<typeof createBudgetMiddleware>,
): NonNullable<(typeof mw)["wrapModelCall"]> {
  const wrap = mw.wrapModelCall;
  if (wrap === undefined) throw new Error("wrapModelCall is undefined");
  return wrap;
}

describe("createBudgetMiddleware", () => {
  test("passes through when under budget", async () => {
    const wrap = getWrap(createBudgetMiddleware(3));
    const next = createMockNext();
    const ctx = createMockTurnContext({ turnIndex: 0 });
    const request = { messages: [], model: "test-model" as const };

    const result = await wrap(ctx, request, next);
    expect(result.content).toBeDefined();
  });

  test("throws RATE_LIMIT when budget exhausted", async () => {
    const wrap = getWrap(createBudgetMiddleware(2));
    const next = createMockNext();
    const ctx = createMockTurnContext({ turnIndex: 0 });
    const request = { messages: [], model: "test-model" as const };

    // Call 1 and 2 — should pass
    await wrap(ctx, request, next);
    await wrap(ctx, request, next);

    // Call 3 — should throw
    await expect(wrap(ctx, request, next)).rejects.toThrow(/budget exhausted/i);
  });

  test("throws on zero maxCalls", () => {
    expect(() => createBudgetMiddleware(0)).toThrow(/positive integer/);
  });

  test("throws on negative maxCalls", () => {
    expect(() => createBudgetMiddleware(-1)).toThrow(/positive integer/);
  });

  test("throws on NaN maxCalls", () => {
    expect(() => createBudgetMiddleware(Number.NaN)).toThrow(/positive integer/);
  });

  test("resets on new turn (ctx.turnIndex change)", async () => {
    const wrap = getWrap(createBudgetMiddleware(1));
    const next = createMockNext();
    const request = { messages: [], model: "test-model" as const };

    // Turn 0: use the budget
    const ctx0 = createMockTurnContext({ turnIndex: 0 });
    await wrap(ctx0, request, next);

    // Turn 0 again: should be exhausted
    await expect(wrap(ctx0, request, next)).rejects.toThrow(/budget exhausted/i);

    // Turn 1: should reset and pass
    const ctx1 = createMockTurnContext({ turnIndex: 1 });
    const result = await wrap(ctx1, request, next);
    expect(result.content).toBeDefined();
  });
});
