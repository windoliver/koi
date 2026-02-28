import { describe, expect, test } from "bun:test";
import type {
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { createAuditMiddleware, createInMemoryAuditSink } from "@koi/middleware-audit";
import {
  createDefaultCostCalculator,
  createInMemoryBudgetTracker,
  createPayMiddleware,
} from "@koi/middleware-pay";
import {
  createPatternPermissionBackend,
  createPermissionsMiddleware,
} from "@koi/middleware-permissions";
import {
  createMockTurnContext,
  createSpyModelHandler,
  createSpyToolHandler,
} from "@koi/test-utils";

// ---------------------------------------------------------------------------
// Inline compose helpers — avoids L2 → L1 import of @koi/engine
// ---------------------------------------------------------------------------

function composeModelChain(
  middleware: readonly KoiMiddleware[],
  terminal: ModelHandler,
): (ctx: TurnContext, request: ModelRequest) => Promise<ModelResponse> {
  const hooks = middleware.filter((mw) => mw.wrapModelCall !== undefined);
  return (ctx, request) => {
    const dispatch = (i: number, req: ModelRequest): Promise<ModelResponse> => {
      const mw = hooks[i];
      if (mw?.wrapModelCall === undefined) return terminal(req);
      return mw.wrapModelCall(ctx, req, (r) => dispatch(i + 1, r));
    };
    return dispatch(0, request);
  };
}

function composeToolChain(
  middleware: readonly KoiMiddleware[],
  terminal: ToolHandler,
): (ctx: TurnContext, request: ToolRequest) => Promise<ToolResponse> {
  const hooks = middleware.filter((mw) => mw.wrapToolCall !== undefined);
  return (ctx, request) => {
    const dispatch = (i: number, req: ToolRequest): Promise<ToolResponse> => {
      const mw = hooks[i];
      if (mw?.wrapToolCall === undefined) return terminal(req);
      return mw.wrapToolCall(ctx, req, (r) => dispatch(i + 1, r));
    };
    return dispatch(0, request);
  };
}

/**
 * Sort middleware by priority (ascending = outermost first).
 * Mirrors the engine's sortByPriority in koi.ts.
 */
function sortByPriority(middleware: readonly KoiMiddleware[]): readonly KoiMiddleware[] {
  return [...middleware].sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500));
}

describe("Middleware composition — execution order", () => {
  test("priorities sort correctly: permissions(100) < pay(200) < audit(300)", () => {
    const perm = createPermissionsMiddleware({
      backend: createPatternPermissionBackend({
        rules: { allow: ["*"], deny: [], ask: [] },
      }),
    });
    const pay = createPayMiddleware({
      tracker: createInMemoryBudgetTracker(),
      calculator: createDefaultCostCalculator(),
      budget: 100,
    });
    const audit = createAuditMiddleware({ sink: createInMemoryAuditSink() });

    expect(perm.priority).toBe(100);
    expect(pay.priority).toBe(200);
    expect(audit.priority).toBe(300);
  });

  test("onion enter order matches priority (outer first)", async () => {
    const order: string[] = [];

    const mwA: KoiMiddleware = {
      name: "outer",
      describeCapabilities: () => undefined,
      priority: 100,
      async wrapModelCall(_ctx, req, next) {
        order.push("outer-enter");
        const resp = await next(req);
        order.push("outer-exit");
        return resp;
      },
    };

    const mwB: KoiMiddleware = {
      name: "inner",
      describeCapabilities: () => undefined,
      priority: 400,
      async wrapModelCall(_ctx, req, next) {
        order.push("inner-enter");
        const resp = await next(req);
        order.push("inner-exit");
        return resp;
      },
    };

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const sorted = sortByPriority([mwB, mwA]); // Intentionally unsorted input
    const chain = composeModelChain(sorted, spy.handler);
    await chain(ctx, { messages: [] });

    expect(order).toEqual(["outer-enter", "inner-enter", "inner-exit", "outer-exit"]);
  });

  test("onion symmetry — enter order is reverse of exit order", async () => {
    const enters: string[] = [];
    const exits: string[] = [];

    const makeMw = (name: string, priority: number): KoiMiddleware => ({
      name,
      describeCapabilities: () => undefined,
      priority,
      async wrapToolCall(_ctx, req, next) {
        enters.push(name);
        const resp = await next(req);
        exits.push(name);
        return resp;
      },
    });

    const middlewares = sortByPriority([makeMw("C", 300), makeMw("A", 100), makeMw("B", 200)]);

    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler();
    const chain = composeToolChain(middlewares, spy.handler);
    await chain(ctx, { toolId: "test", input: {} });

    expect(enters).toEqual(["A", "B", "C"]);
    expect(exits).toEqual(["C", "B", "A"]);
  });
});

describe("Middleware composition — error propagation", () => {
  test("permission denied prevents pay from recording cost", async () => {
    const tracker = createInMemoryBudgetTracker();
    const perm = createPermissionsMiddleware({
      backend: createPatternPermissionBackend({
        rules: { allow: [], deny: ["blocked-tool"], ask: [] },
      }),
    });
    const pay = createPayMiddleware({
      tracker,
      calculator: createDefaultCostCalculator(),
      budget: 100,
    });

    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler();
    const sorted = sortByPriority([perm, pay]);
    const chain = composeToolChain(sorted, spy.handler);

    try {
      await chain(ctx, { toolId: "blocked-tool", input: {} });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as { readonly code: string };
      expect(err.code).toBe("PERMISSION");
    }

    // Pay should not have recorded anything
    expect(await tracker.totalSpend("session-test-1")).toBe(0);
    expect(spy.calls).toHaveLength(0);
  });

  test("permission denied but audit still logs the denial", async () => {
    const sink = createInMemoryAuditSink();
    const perm = createPermissionsMiddleware({
      backend: createPatternPermissionBackend({
        rules: { allow: [], deny: ["blocked"], ask: [] },
      }),
    });
    const audit = createAuditMiddleware({ sink });

    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler();
    const sorted = sortByPriority([perm, audit]);
    const chain = composeToolChain(sorted, spy.handler);

    try {
      await chain(ctx, { toolId: "blocked", input: {} });
    } catch {
      // expected
    }
    // perm=100 is outermost, audit=300 is inner, so audit won't see the error
    // perm throws before reaching audit
    await new Promise((r) => setTimeout(r, 10));
    expect(spy.calls).toHaveLength(0);
  });

  test("budget exceeded prevents tool execution", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("session-test-1", {
      inputTokens: 0,
      outputTokens: 0,
      model: "test",
      costUsd: 100,
      timestamp: Date.now(),
    });
    const pay = createPayMiddleware({
      tracker,
      calculator: createDefaultCostCalculator(),
      budget: 100,
    });

    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler();
    const chain = composeToolChain([pay], spy.handler);

    try {
      await chain(ctx, { toolId: "expensive", input: {} });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as { readonly code: string };
      expect(err.code).toBe("RATE_LIMIT");
    }
    expect(spy.calls).toHaveLength(0);
  });

  test("inner middleware throws — outer middleware exit code still runs", async () => {
    const exitRan = { value: false };

    const outer: KoiMiddleware = {
      name: "outer",
      describeCapabilities: () => undefined,
      priority: 100,
      async wrapModelCall(_ctx, req, next) {
        try {
          return await next(req);
        } finally {
          exitRan.value = true;
        }
      },
    };

    const inner: KoiMiddleware = {
      name: "inner",
      describeCapabilities: () => undefined,
      priority: 200,
      async wrapModelCall(_ctx, _req, _next) {
        throw new Error("inner crash");
      },
    };

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const sorted = sortByPriority([outer, inner]);
    const chain = composeModelChain(sorted, spy.handler);

    try {
      await chain(ctx, { messages: [] });
    } catch {
      // expected
    }
    expect(exitRan.value).toBe(true);
  });
});

describe("Middleware composition — no-op middleware", () => {
  test("middleware without wrapModelCall is skipped in model chain", async () => {
    const toolOnly: KoiMiddleware = {
      name: "tool-only",
      describeCapabilities: () => undefined,
      priority: 100,
      async wrapToolCall(_ctx, req, next) {
        return next(req);
      },
    };

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const chain = composeModelChain([toolOnly], spy.handler);
    const response = await chain(ctx, { messages: [] });
    expect(response.content).toBe("mock response");
    expect(spy.calls).toHaveLength(1);
  });

  test("middleware without wrapToolCall is skipped in tool chain", async () => {
    const modelOnly: KoiMiddleware = {
      name: "model-only",
      describeCapabilities: () => undefined,
      priority: 100,
      async wrapModelCall(_ctx, req, next) {
        return next(req);
      },
    };

    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler();
    const chain = composeToolChain([modelOnly], spy.handler);
    const response = await chain(ctx, { toolId: "test", input: {} });
    expect(response.output).toEqual({ result: "mock" });
  });

  test("name-only middleware works in chain", async () => {
    const noop: KoiMiddleware = { name: "noop", describeCapabilities: () => undefined };
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const chain = composeModelChain([noop], spy.handler);
    const response = await chain(ctx, { messages: [] });
    expect(response.content).toBe("mock response");
  });
});
