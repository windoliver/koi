import { describe, expect, mock, test } from "bun:test";
import type { ModelRequest, ModelResponse, ToolRequest, ToolResponse } from "@koi/core";
import {
  createMockTurnContext,
  createSpyModelHandler,
  createSpyToolHandler,
} from "@koi/test-utils";
import { createSemanticRetryMiddleware } from "./semantic-retry.js";
import type { FailureAnalyzer, FailureContext } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockCtx = createMockTurnContext();

const baseRequest: ModelRequest = {
  messages: [
    {
      senderId: "user-1",
      content: [{ kind: "text", text: "Hello" }],
      timestamp: 1700000000000,
    },
  ],
};

const baseToolRequest: ToolRequest = {
  toolId: "test-tool",
  input: { key: "value" },
};

function createFailingModelHandler(error: Error): (req: ModelRequest) => Promise<ModelResponse> {
  return async (_req: ModelRequest): Promise<ModelResponse> => {
    throw error;
  };
}

function createFailingToolHandler(error: Error): (req: ToolRequest) => Promise<ToolResponse> {
  return async (_req: ToolRequest): Promise<ToolResponse> => {
    throw error;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSemanticRetryMiddleware", () => {
  test("has correct middleware name", () => {
    const handle = createSemanticRetryMiddleware({});
    expect(handle.middleware.name).toBe("semantic-retry");
  });

  test("has correct middleware priority", () => {
    const handle = createSemanticRetryMiddleware({});
    expect(handle.middleware.priority).toBe(420);
  });

  describe("passthrough (no failures)", () => {
    test("passes model call through unchanged when no pending action", async () => {
      const handle = createSemanticRetryMiddleware({});
      const spy = createSpyModelHandler();

      const response = await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);

      expect(response).toBeDefined();
      expect(response?.content).toBe("mock response");
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.messages).toHaveLength(1);
    });

    test("passes tool call through unchanged when no pending action", async () => {
      const handle = createSemanticRetryMiddleware({});
      const spy = createSpyToolHandler();

      const response = await handle.middleware.wrapToolCall?.(
        mockCtx,
        baseToolRequest,
        spy.handler,
      );

      expect(response).toBeDefined();
      expect(spy.calls).toHaveLength(1);
    });

    test("records remain empty after successful calls", async () => {
      const handle = createSemanticRetryMiddleware({});
      const spy = createSpyModelHandler();

      await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);

      expect(handle.getRecords()).toHaveLength(0);
    });
  });

  describe("model call failure detection", () => {
    test("catches model call error and sets pending action", async () => {
      const handle = createSemanticRetryMiddleware({});
      const error = new Error("model failed");

      await expect(
        handle.middleware.wrapModelCall?.(mockCtx, baseRequest, createFailingModelHandler(error)),
      ).rejects.toThrow("model failed");

      // After the error, a record should exist
      expect(handle.getRecords()).toHaveLength(1);
      expect(handle.getRecords()[0]?.succeeded).toBe(false);
    });

    test("decrements retry budget on failure", async () => {
      const handle = createSemanticRetryMiddleware({ maxRetries: 3 });
      const error = new Error("model failed");

      expect(handle.getRetryBudget()).toBe(3);

      await expect(
        handle.middleware.wrapModelCall?.(mockCtx, baseRequest, createFailingModelHandler(error)),
      ).rejects.toThrow();

      expect(handle.getRetryBudget()).toBe(2);
    });
  });

  describe("prompt rewriting on subsequent call", () => {
    test("applies rewrite on model call after failure", async () => {
      const handle = createSemanticRetryMiddleware({});
      const spy = createSpyModelHandler();

      // First call fails
      await expect(
        handle.middleware.wrapModelCall?.(
          mockCtx,
          baseRequest,
          createFailingModelHandler(new Error("fail")),
        ),
      ).rejects.toThrow();

      // Second call should have rewritten prompt
      await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);

      expect(spy.calls).toHaveLength(1);
      // Should have more messages than original (injected retry guidance)
      expect(spy.calls[0]?.messages.length).toBeGreaterThan(baseRequest.messages.length);
    });

    test("clears pending action after rewrite is applied", async () => {
      const handle = createSemanticRetryMiddleware({});
      const spy = createSpyModelHandler();

      // Fail then succeed
      await expect(
        handle.middleware.wrapModelCall?.(
          mockCtx,
          baseRequest,
          createFailingModelHandler(new Error("fail")),
        ),
      ).rejects.toThrow();
      await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);

      // Third call should be passthrough (no more pending action)
      await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
      expect(spy.calls).toHaveLength(2);
      // Third call should have original message count (no injection)
      expect(spy.calls[1]?.messages).toHaveLength(1);
    });
  });

  describe("tool call failure detection", () => {
    test("catches tool call error and records failure", async () => {
      const handle = createSemanticRetryMiddleware({});
      const error = new Error("tool failed");

      await expect(
        handle.middleware.wrapToolCall?.(mockCtx, baseToolRequest, createFailingToolHandler(error)),
      ).rejects.toThrow("tool failed");

      expect(handle.getRecords()).toHaveLength(1);
    });

    test("sets pending action after tool failure for next model call", async () => {
      const handle = createSemanticRetryMiddleware({});
      const spy = createSpyModelHandler();

      // Tool fails
      await expect(
        handle.middleware.wrapToolCall?.(
          mockCtx,
          baseToolRequest,
          createFailingToolHandler(new Error("tool error")),
        ),
      ).rejects.toThrow();

      // Next model call should have rewritten prompt
      await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
      expect(spy.calls[0]?.messages.length).toBeGreaterThan(baseRequest.messages.length);
    });
  });

  describe("budget enforcement", () => {
    test("forces abort when budget is exhausted", async () => {
      const handle = createSemanticRetryMiddleware({ maxRetries: 1 });

      // First failure uses the budget
      await expect(
        handle.middleware.wrapModelCall?.(
          mockCtx,
          baseRequest,
          createFailingModelHandler(new Error("fail")),
        ),
      ).rejects.toThrow();

      // Budget should be 0
      expect(handle.getRetryBudget()).toBe(0);

      // Next model call should throw abort (not attempt rewrite)
      await expect(
        handle.middleware.wrapModelCall?.(mockCtx, baseRequest, createSpyModelHandler().handler),
      ).rejects.toThrow(/abort/i);
    });
  });

  describe("rolling window", () => {
    test("trims records beyond maxHistorySize", async () => {
      const handle = createSemanticRetryMiddleware({
        maxRetries: 100,
        maxHistorySize: 3,
      });

      // Generate 5 failures
      for (const _ of Array.from({ length: 5 })) {
        try {
          await handle.middleware.wrapModelCall?.(
            mockCtx,
            baseRequest,
            createFailingModelHandler(new Error("fail")),
          );
        } catch (_e: unknown) {
          // Expected — failures accumulate
        }
      }

      expect(handle.getRecords().length).toBeLessThanOrEqual(3);
    });
  });

  describe("analyzer timeout", () => {
    test("falls back to add_context when analyzer times out", async () => {
      const slowAnalyzer: FailureAnalyzer = {
        classify: async (_ctx: FailureContext) => {
          // Simulate slow analyzer — should be caught by timeout
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          return { kind: "unknown", reason: "should not reach" };
        },
        selectAction: () => ({ kind: "abort", reason: "should not reach" }),
      };

      const handle = createSemanticRetryMiddleware({
        analyzer: slowAnalyzer,
        analyzerTimeoutMs: 50,
      });

      await expect(
        handle.middleware.wrapModelCall?.(
          mockCtx,
          baseRequest,
          createFailingModelHandler(new Error("fail")),
        ),
      ).rejects.toThrow();

      // Should have fallen back — record should exist with a non-abort action
      const records = handle.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.actionTaken.kind).toBe("add_context");
    });
  });

  describe("rewriter timeout", () => {
    test("passes original request when rewriter times out", async () => {
      const slowRewriter = {
        rewrite: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          return baseRequest;
        },
      };

      const handle = createSemanticRetryMiddleware({
        rewriter: slowRewriter,
        rewriterTimeoutMs: 50,
      });
      const spy = createSpyModelHandler();

      // Fail to set pending action
      await expect(
        handle.middleware.wrapModelCall?.(
          mockCtx,
          baseRequest,
          createFailingModelHandler(new Error("fail")),
        ),
      ).rejects.toThrow();

      // Next call: rewriter times out → original request used
      await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
      expect(spy.calls[0]?.messages).toHaveLength(1); // original, not rewritten
    });
  });

  describe("custom analyzer/rewriter", () => {
    test("uses custom analyzer when provided", async () => {
      const classifyFn = mock(() => ({ kind: "hallucination" as const, reason: "custom" }));
      const selectActionFn = mock(() => ({
        kind: "redirect" as const,
        newApproach: "custom approach",
      }));

      const handle = createSemanticRetryMiddleware({
        analyzer: { classify: classifyFn, selectAction: selectActionFn },
      });

      await expect(
        handle.middleware.wrapModelCall?.(
          mockCtx,
          baseRequest,
          createFailingModelHandler(new Error("fail")),
        ),
      ).rejects.toThrow();

      expect(classifyFn).toHaveBeenCalled();
      expect(selectActionFn).toHaveBeenCalled();
      expect(handle.getRecords()[0]?.failureClass.kind).toBe("hallucination");
    });
  });

  describe("onRetry callback", () => {
    test("invokes onRetry with record after failure", async () => {
      const onRetry = mock(() => {});
      const handle = createSemanticRetryMiddleware({ onRetry });

      await expect(
        handle.middleware.wrapModelCall?.(
          mockCtx,
          baseRequest,
          createFailingModelHandler(new Error("fail")),
        ),
      ).rejects.toThrow();

      expect(onRetry).toHaveBeenCalledTimes(1);
      const calls = onRetry.mock.calls as unknown[][];
      const record = calls[0]?.[0] as { readonly succeeded: boolean } | undefined;
      expect(record).toBeDefined();
      expect(record?.succeeded).toBe(false);
    });
  });

  describe("reset()", () => {
    test("clears all state", async () => {
      const handle = createSemanticRetryMiddleware({ maxRetries: 5 });

      // Accumulate some state
      await expect(
        handle.middleware.wrapModelCall?.(
          mockCtx,
          baseRequest,
          createFailingModelHandler(new Error("fail")),
        ),
      ).rejects.toThrow();

      expect(handle.getRecords()).toHaveLength(1);
      expect(handle.getRetryBudget()).toBe(4);

      handle.reset();

      expect(handle.getRecords()).toHaveLength(0);
      expect(handle.getRetryBudget()).toBe(5);
    });
  });

  describe("analyzer error handling", () => {
    test("falls back to add_context when analyzer.classify throws", async () => {
      const brokenAnalyzer: FailureAnalyzer = {
        classify: () => {
          throw new Error("analyzer bug");
        },
        selectAction: () => ({ kind: "abort", reason: "unused" }),
      };

      const handle = createSemanticRetryMiddleware({ analyzer: brokenAnalyzer });

      await expect(
        handle.middleware.wrapModelCall?.(
          mockCtx,
          baseRequest,
          createFailingModelHandler(new Error("fail")),
        ),
      ).rejects.toThrow("fail");

      expect(handle.getRecords()).toHaveLength(1);
      expect(handle.getRecords()[0]?.actionTaken.kind).toBe("add_context");
    });

    test("falls back to add_context when analyzer.selectAction throws", async () => {
      const brokenAnalyzer: FailureAnalyzer = {
        classify: () => ({ kind: "api_error", reason: "classified ok" }),
        selectAction: () => {
          throw new Error("selectAction bug");
        },
      };

      const handle = createSemanticRetryMiddleware({ analyzer: brokenAnalyzer });

      await expect(
        handle.middleware.wrapModelCall?.(
          mockCtx,
          baseRequest,
          createFailingModelHandler(new Error("fail")),
        ),
      ).rejects.toThrow("fail");

      expect(handle.getRecords()).toHaveLength(1);
      expect(handle.getRecords()[0]?.actionTaken.kind).toBe("add_context");
    });
  });

  describe("budget underflow guard", () => {
    test("budget never goes negative after exhaustion", async () => {
      const handle = createSemanticRetryMiddleware({ maxRetries: 1 });

      // First failure: budget 1 → 0, sets abort
      await expect(
        handle.middleware.wrapModelCall?.(
          mockCtx,
          baseRequest,
          createFailingModelHandler(new Error("fail-1")),
        ),
      ).rejects.toThrow("fail-1");

      expect(handle.getRetryBudget()).toBe(0);
      expect(handle.getRecords()).toHaveLength(1);

      // Second failure after budget exhausted: should be ignored, budget stays 0
      await expect(
        handle.middleware.wrapToolCall?.(
          mockCtx,
          baseToolRequest,
          createFailingToolHandler(new Error("tool-fail-after-budget")),
        ),
      ).rejects.toThrow("tool-fail-after-budget");

      expect(handle.getRetryBudget()).toBe(0);
      // No new record added — handleFailure skipped
      expect(handle.getRecords()).toHaveLength(1);
    });
  });
});
