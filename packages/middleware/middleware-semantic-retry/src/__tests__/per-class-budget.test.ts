/**
 * Integration tests for per-failure-class retry budgets.
 *
 * Verifies that budgetOverrides allow different retry limits per failure class,
 * and that classes operate independently of each other.
 */

import { describe, expect, test } from "bun:test";
import type { KoiError, ModelRequest, ModelResponse } from "@koi/core";
import { createMockSessionContext, createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import { createSemanticRetryMiddleware } from "../semantic-retry.js";
import type { FailureAnalyzer, FailureContext, SemanticRetryHandle } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSessionCtx = createMockSessionContext();
const mockCtx = createMockTurnContext();

async function initSession(handle: SemanticRetryHandle): Promise<void> {
  await handle.middleware.onSessionStart?.(mockSessionCtx);
}

const baseRequest: ModelRequest = {
  messages: [
    {
      senderId: "user-1",
      content: [{ kind: "text", text: "Do something" }],
      timestamp: 1700000000000,
    },
  ],
};

function createFailingHandler(error: Error): (req: ModelRequest) => Promise<ModelResponse> {
  return async (): Promise<ModelResponse> => {
    throw error;
  };
}

function makeKoiError(code: string, message: string): KoiError {
  return { code: code as KoiError["code"], message, retryable: false };
}

/**
 * Creates an analyzer that classifies by KoiError code and always returns
 * add_context, so we can observe budget behavior without escalation ladder
 * interference.
 */
function createClassifyingAnalyzer(): FailureAnalyzer {
  return {
    classify(ctx: FailureContext) {
      const error = ctx.error;
      if (
        error !== null &&
        error !== undefined &&
        typeof error === "object" &&
        "code" in error
      ) {
        // eslint-disable-next-line -- narrowing unknown via Record
        const code = (error as Record<string, unknown>).code;
        if (code === "VALIDATION") {
          return { kind: "validation_failure" as const, reason: "validation error" };
        }
        if (code === "TIMEOUT" || code === "RATE_LIMIT" || code === "EXTERNAL") {
          return { kind: "api_error" as const, reason: "api error" };
        }
      }
      return { kind: "unknown" as const, reason: "unknown" };
    },
    selectAction(_failure, _records) {
      return { kind: "add_context" as const, context: "retry info" };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("per-failure-class retry budgets", () => {
  test("validation_failure uses budgetOverride (1) instead of global maxRetries (3)", async () => {
    const handle = createSemanticRetryMiddleware({
      maxRetries: 3,
      budgetOverrides: { validation_failure: 1 },
      analyzer: createClassifyingAnalyzer(),
    });
    await initSession(handle);

    // First validation failure: budget goes from 1 → 0
    const validationError = Object.assign(new Error("bad schema"), makeKoiError("VALIDATION", "bad schema"));
    await expect(
      handle.middleware.wrapModelCall?.(mockCtx, baseRequest, createFailingHandler(validationError)),
    ).rejects.toThrow();

    expect(handle.getRecords()).toHaveLength(1);
    expect(handle.getRecords()[0]?.failureClass.kind).toBe("validation_failure");

    // Second validation failure: budget is already 0, handleFailure skips
    await expect(
      handle.middleware.wrapModelCall?.(mockCtx, baseRequest, createFailingHandler(validationError)),
    ).rejects.toThrow();

    // Only 1 record because the second validation failure was skipped (budget exhausted)
    // But the pending action from first failure was consumed, so now the second error
    // is from the model call itself (re-thrown), but no new record added
    expect(handle.getRecords()).toHaveLength(1);
  });

  test("api_error uses its own budget independently of validation budget", async () => {
    const handle = createSemanticRetryMiddleware({
      maxRetries: 3,
      budgetOverrides: { validation_failure: 1, api_error: 2 },
      analyzer: createClassifyingAnalyzer(),
    });
    await initSession(handle);

    // Validation failure: budget 1 → 0
    const validationError = Object.assign(
      new Error("bad schema"),
      makeKoiError("VALIDATION", "bad schema"),
    );
    await expect(
      handle.middleware.wrapModelCall?.(mockCtx, baseRequest, createFailingHandler(validationError)),
    ).rejects.toThrow();

    expect(handle.getRecords()).toHaveLength(1);
    expect(handle.getRecords()[0]?.failureClass.kind).toBe("validation_failure");

    // Consume the pending abort action (validation budget exhausted → abort)
    const spy = createSpyModelHandler();
    await expect(
      handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler),
    ).rejects.toThrow("Semantic retry aborted");

    // API error: budget should still be 2
    const apiError = Object.assign(new Error("timeout"), makeKoiError("TIMEOUT", "timeout"));
    await expect(
      handle.middleware.wrapModelCall?.(mockCtx, baseRequest, createFailingHandler(apiError)),
    ).rejects.toThrow();

    expect(handle.getRecords()).toHaveLength(2);
    expect(handle.getRecords()[1]?.failureClass.kind).toBe("api_error");

    // Consume pending action
    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);

    // Second API error: budget 2 → 1 → can still record
    await expect(
      handle.middleware.wrapModelCall?.(mockCtx, baseRequest, createFailingHandler(apiError)),
    ).rejects.toThrow();

    expect(handle.getRecords()).toHaveLength(3);
    expect(handle.getRecords()[2]?.failureClass.kind).toBe("api_error");
  });

  test("unspecified failure classes fall back to maxRetries", async () => {
    const handle = createSemanticRetryMiddleware({
      maxRetries: 2,
      budgetOverrides: { validation_failure: 1 },
      analyzer: createClassifyingAnalyzer(),
    });
    await initSession(handle);
    const spy = createSpyModelHandler();

    // Unknown error: should use maxRetries (2)
    const unknownError = new Error("something broke");
    await expect(
      handle.middleware.wrapModelCall?.(mockCtx, baseRequest, createFailingHandler(unknownError)),
    ).rejects.toThrow();

    // Consume pending
    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);

    // Second unknown error: budget 2 → 1 → still records
    await expect(
      handle.middleware.wrapModelCall?.(mockCtx, baseRequest, createFailingHandler(unknownError)),
    ).rejects.toThrow();

    const unknownRecords = handle.getRecords().filter((r) => r.failureClass.kind === "unknown");
    expect(unknownRecords).toHaveLength(2);
  });

  test("getRetryBudget returns minimum across all classes", async () => {
    const handle = createSemanticRetryMiddleware({
      maxRetries: 5,
      budgetOverrides: { validation_failure: 1, api_error: 3 },
      analyzer: createClassifyingAnalyzer(),
    });
    await initSession(handle);

    // Initial budget: min(1, 3, 5, 5, 5, 5, 5) = 1
    expect(handle.getRetryBudget()).toBe(1);

    // After one validation failure: min(0, 3, 5, 5, 5, 5, 5) = 0
    const validationError = Object.assign(
      new Error("bad"),
      makeKoiError("VALIDATION", "bad"),
    );
    await expect(
      handle.middleware.wrapModelCall?.(mockCtx, baseRequest, createFailingHandler(validationError)),
    ).rejects.toThrow();

    expect(handle.getRetryBudget()).toBe(0);
  });

  test("reset restores per-class budgets to initial values", async () => {
    const handle = createSemanticRetryMiddleware({
      maxRetries: 5,
      budgetOverrides: { validation_failure: 1 },
      analyzer: createClassifyingAnalyzer(),
    });
    await initSession(handle);

    // Exhaust validation budget
    const validationError = Object.assign(
      new Error("bad"),
      makeKoiError("VALIDATION", "bad"),
    );
    await expect(
      handle.middleware.wrapModelCall?.(mockCtx, baseRequest, createFailingHandler(validationError)),
    ).rejects.toThrow();

    expect(handle.getRetryBudget()).toBe(0);

    // Reset
    handle.reset();

    // Budget should be back to initial: min(1, 5, 5, ...) = 1
    expect(handle.getRetryBudget()).toBe(1);
    expect(handle.getRecords()).toHaveLength(0);
  });
});
