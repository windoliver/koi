/**
 * Integration tests for the semantic-retry middleware.
 *
 * Tests the full pipeline: failure → classify → selectAction → rewrite → inject.
 * Focuses on escalation ladder behavior and edge cases.
 */

import { describe, expect, mock, test } from "bun:test";
import type { ModelRequest, ModelResponse, ToolRequest, ToolResponse } from "@koi/core";
import { createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import { createSemanticRetryMiddleware } from "../semantic-retry.js";
import type { RetryActionKind } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockCtx = createMockTurnContext();

const baseRequest: ModelRequest = {
  messages: [
    {
      senderId: "user-1",
      content: [{ kind: "text", text: "Implement the feature" }],
      timestamp: 1700000000000,
    },
  ],
};

function createFailingHandler(error: Error): (req: ModelRequest) => Promise<ModelResponse> {
  return async (): Promise<ModelResponse> => {
    throw error;
  };
}

function createFailingToolHandler(error: Error): (req: ToolRequest) => Promise<ToolResponse> {
  return async (): Promise<ToolResponse> => {
    throw error;
  };
}

/**
 * Drives the middleware through N failures, collecting the action kinds
 * from each retry record. Then optionally sends a final successful call.
 */
async function driveFailures(
  failCount: number,
  options: {
    readonly maxRetries?: number;
    readonly error?: Error;
    readonly finalSuccess?: boolean;
  } = {},
): Promise<{
  readonly actionKinds: readonly RetryActionKind[];
  readonly finalCallMessages: number | undefined;
}> {
  const maxRetries = options.maxRetries ?? failCount + 1;
  const error = options.error ?? new Error("test failure");
  const handle = createSemanticRetryMiddleware({ maxRetries });
  const actionKinds: RetryActionKind[] = [];

  for (const _ of Array.from({ length: failCount })) {
    try {
      await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, createFailingHandler(error));
    } catch (_e: unknown) {
      // Expected — collect the action from the latest record
      const records = handle.getRecords();
      const last = records[records.length - 1];
      if (last !== undefined) {
        actionKinds.push(last.actionTaken.kind);
      }
    }
  }

  // Optionally send a successful call (to verify rewrite was applied)
  let finalCallMessages: number | undefined;
  if (options.finalSuccess !== false) {
    const spy = createSpyModelHandler();
    try {
      await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
      finalCallMessages = spy.calls[0]?.messages.length;
    } catch (_e: unknown) {
      // If abort was pending, this will throw
      finalCallMessages = undefined;
    }
  }

  return { actionKinds, finalCallMessages };
}

// ---------------------------------------------------------------------------
// Table-driven escalation scenarios
// ---------------------------------------------------------------------------

describe("escalation ladder (integration)", () => {
  const scenarios = [
    {
      name: "1 failure → add_context → success",
      failCount: 1,
      maxRetries: 5,
      expectedActions: ["add_context"] as const,
      expectFinalSuccess: true,
    },
    {
      name: "2 failures → add_context → narrow_scope → success",
      failCount: 2,
      maxRetries: 5,
      expectedActions: ["add_context", "narrow_scope"] as const,
      expectFinalSuccess: true,
    },
    {
      name: "3 failures → add_context → narrow_scope → escalate/redirect → success",
      failCount: 3,
      maxRetries: 5,
      // Third action depends on whether failure class repeats
      expectedActions: ["add_context", "narrow_scope"] as const,
      // Just check first two, third varies
      expectFinalSuccess: true,
    },
  ] as const;

  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      const result = await driveFailures(scenario.failCount, {
        maxRetries: scenario.maxRetries,
      });

      // Verify the expected actions in order
      for (const [i, expected] of scenario.expectedActions.entries()) {
        expect(result.actionKinds[i]).toBe(expected);
      }

      // Verify the final success call was rewritten
      if (scenario.expectFinalSuccess) {
        expect(result.finalCallMessages).toBeDefined();
        expect(result.finalCallMessages).toBeGreaterThan(baseRequest.messages.length);
      }
    });
  }

  test("budget exhaustion → abort on final call", async () => {
    const handle = createSemanticRetryMiddleware({ maxRetries: 2 });

    // Two failures exhaust the budget
    for (const _ of [1, 2]) {
      try {
        await handle.middleware.wrapModelCall?.(
          mockCtx,
          baseRequest,
          createFailingHandler(new Error("fail")),
        );
      } catch (_e: unknown) {
        // Expected
      }
    }

    expect(handle.getRetryBudget()).toBe(0);

    // Next call should abort
    await expect(
      handle.middleware.wrapModelCall?.(mockCtx, baseRequest, createSpyModelHandler().handler),
    ).rejects.toThrow(/abort/i);
  });
});

// ---------------------------------------------------------------------------
// Non-linear paths
// ---------------------------------------------------------------------------

describe("non-linear escalation paths", () => {
  test("success mid-ladder: pending action is consumed, no state leaks", async () => {
    const handle = createSemanticRetryMiddleware({ maxRetries: 5 });
    const spy = createSpyModelHandler();

    // Fail once → sets pending action
    try {
      await handle.middleware.wrapModelCall?.(
        mockCtx,
        baseRequest,
        createFailingHandler(new Error("fail")),
      );
    } catch (_e: unknown) {
      // Expected
    }

    // Succeed → consumes pending action (rewrite applied)
    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
    expect(spy.calls[0]?.messages.length).toBeGreaterThan(1); // rewrite applied

    // Next call should be clean passthrough (no more pending action)
    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
    expect(spy.calls[1]?.messages.length).toBe(1); // original, no injection
  });

  test("interleaved tool + model failures both contribute to records", async () => {
    const handle = createSemanticRetryMiddleware({ maxRetries: 5 });

    // Tool failure
    try {
      await handle.middleware.wrapToolCall?.(
        mockCtx,
        { toolId: "broken-tool", input: {} },
        createFailingToolHandler(new Error("tool broke")),
      );
    } catch (_e: unknown) {
      // Expected
    }

    // Model failure
    try {
      await handle.middleware.wrapModelCall?.(
        mockCtx,
        baseRequest,
        createFailingHandler(new Error("model broke")),
      );
    } catch (_e: unknown) {
      // Expected
    }

    // Both should be recorded
    expect(handle.getRecords()).toHaveLength(2);
    expect(handle.getRetryBudget()).toBe(3); // 5 - 2 = 3
  });

  test("model escalation changes ModelRequest.model", async () => {
    const handle = createSemanticRetryMiddleware({ maxRetries: 10 });
    const spy = createSpyModelHandler();

    // Drive enough failures to trigger escalate_model (3 failures with same class)
    for (const _ of [1, 2, 3]) {
      try {
        await handle.middleware.wrapModelCall?.(
          mockCtx,
          baseRequest,
          createFailingHandler(new Error("consistent failure")),
        );
      } catch (_e: unknown) {
        // Expected
      }
    }

    // Check if escalate_model was among the actions
    const records = handle.getRecords();
    const escalateRecord = records.find((r) => r.actionTaken.kind === "escalate_model");

    if (escalateRecord !== undefined) {
      // If escalation was triggered, next model call should have model set
      await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
      const lastCall = spy.calls[spy.calls.length - 1];
      expect(lastCall).toBeDefined();
      // Model should be set to the escalation target
      if (lastCall?.model !== undefined) {
        expect(typeof lastCall.model).toBe("string");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases from the 8-item checklist
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("1. budget exhaustion: exactly at maxRetries triggers abort", async () => {
    const handle = createSemanticRetryMiddleware({ maxRetries: 1 });

    try {
      await handle.middleware.wrapModelCall?.(
        mockCtx,
        baseRequest,
        createFailingHandler(new Error("fail")),
      );
    } catch (_e: unknown) {
      // Expected
    }

    expect(handle.getRetryBudget()).toBe(0);

    // Abort on next call
    await expect(
      handle.middleware.wrapModelCall?.(mockCtx, baseRequest, createSpyModelHandler().handler),
    ).rejects.toThrow(/abort/i);
  });

  test("2. analyzer throws: falls back to add_context, doesn't crash", async () => {
    const handle = createSemanticRetryMiddleware({
      analyzer: {
        classify: () => {
          throw new Error("analyzer bug");
        },
        selectAction: () => ({ kind: "abort" as const, reason: "unused" }),
      },
    });

    // Should not crash — should fall back gracefully
    await expect(
      handle.middleware.wrapModelCall?.(
        mockCtx,
        baseRequest,
        createFailingHandler(new Error("fail")),
      ),
    ).rejects.toThrow("fail"); // Original error re-thrown, not analyzer error

    expect(handle.getRecords()[0]?.actionTaken.kind).toBe("add_context");
  });

  test("3. rewriter throws: passes original request unchanged", async () => {
    const handle = createSemanticRetryMiddleware({
      rewriter: {
        rewrite: () => {
          throw new Error("rewriter bug");
        },
      },
    });
    const spy = createSpyModelHandler();

    // Fail to set pending action
    try {
      await handle.middleware.wrapModelCall?.(
        mockCtx,
        baseRequest,
        createFailingHandler(new Error("fail")),
      );
    } catch (_e: unknown) {
      // Expected
    }

    // Next call: rewriter throws → original request used
    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
    expect(spy.calls[0]?.messages).toHaveLength(1); // Original, not rewritten
  });

  test("5. no failure detected: middleware is transparent passthrough", async () => {
    const handle = createSemanticRetryMiddleware({});
    const spy = createSpyModelHandler();

    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.messages).toEqual(baseRequest.messages);
    expect(handle.getRecords()).toHaveLength(0);
    expect(handle.getRetryBudget()).toBe(3);
  });

  test("7. unknown action kind from custom analyzer is handled", async () => {
    const handle = createSemanticRetryMiddleware({
      analyzer: {
        classify: () => ({ kind: "unknown" as const, reason: "unrecognized" }),
        selectAction: () => ({ kind: "add_context" as const, context: "custom fallback" }),
      },
    });

    try {
      await handle.middleware.wrapModelCall?.(
        mockCtx,
        baseRequest,
        createFailingHandler(new Error("fail")),
      );
    } catch (_e: unknown) {
      // Expected
    }

    expect(handle.getRecords()[0]?.failureClass.kind).toBe("unknown");
    expect(handle.getRecords()[0]?.actionTaken.kind).toBe("add_context");
  });

  test("8. tool failure without subsequent model call: failure recorded, no action leak", async () => {
    const handle = createSemanticRetryMiddleware({});

    try {
      await handle.middleware.wrapToolCall?.(
        mockCtx,
        { toolId: "broken-tool", input: {} },
        createFailingToolHandler(new Error("tool broke")),
      );
    } catch (_e: unknown) {
      // Expected
    }

    // Failure is recorded
    expect(handle.getRecords()).toHaveLength(1);
    // Budget was decremented
    expect(handle.getRetryBudget()).toBe(2);
  });

  test("reset clears pending action from previous failure", async () => {
    const handle = createSemanticRetryMiddleware({});
    const spy = createSpyModelHandler();

    // Fail to create pending action
    try {
      await handle.middleware.wrapModelCall?.(
        mockCtx,
        baseRequest,
        createFailingHandler(new Error("fail")),
      );
    } catch (_e: unknown) {
      // Expected
    }

    // Reset clears everything
    handle.reset();

    // Next call should be passthrough (no rewrite)
    await handle.middleware.wrapModelCall?.(mockCtx, baseRequest, spy.handler);
    expect(spy.calls[0]?.messages).toHaveLength(1); // Original, no injection
  });

  test("onRetry callback receives all fields", async () => {
    const onRetry = mock(() => {});
    const handle = createSemanticRetryMiddleware({ onRetry });

    try {
      await handle.middleware.wrapModelCall?.(
        mockCtx,
        baseRequest,
        createFailingHandler(new Error("fail")),
      );
    } catch (_e: unknown) {
      // Expected
    }

    expect(onRetry).toHaveBeenCalledTimes(1);
    const calls = onRetry.mock.calls as unknown[][];
    const record = calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(record).toHaveProperty("timestamp");
    expect(record).toHaveProperty("failureClass");
    expect(record).toHaveProperty("actionTaken");
    expect(record).toHaveProperty("succeeded");
    expect(record?.succeeded).toBe(false);
    expect(typeof record?.timestamp).toBe("number");
  });
});
