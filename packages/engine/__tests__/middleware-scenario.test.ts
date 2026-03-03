import { describe, expect, test } from "bun:test";
import type {
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ToolHandler,
  ToolRequest,
  TurnContext,
} from "@koi/core";
import { createAuditMiddleware, createInMemoryAuditSink } from "@koi/middleware-audit";
import {
  createDefaultCostCalculator,
  createInMemoryBudgetTracker,
  createPayMiddleware,
} from "@koi/middleware-pay";
import {
  createMockSessionContext,
  createMockTurnContext,
  createSpyModelHandler,
  createSpyToolHandler,
} from "@koi/test-utils";

// ---------------------------------------------------------------------------
// Inline permission middleware stub — avoids L2 cycle (@koi/middleware-permissions -> @koi/engine)
// ---------------------------------------------------------------------------

interface StubMemoryEntry {
  readonly content: string;
  readonly timestamp: number;
}

function createStubMemoryMiddleware(): {
  readonly middleware: KoiMiddleware;
  readonly recall: (query: string, max: number) => readonly StubMemoryEntry[];
} {
  const entries: StubMemoryEntry[] = [];
  return {
    middleware: {
      name: "memory",
      priority: 400,
      async wrapModelCall(ctx, request, next) {
        const response = await next(request);
        if (response.content) {
          entries.push({ content: response.content, timestamp: Date.now() });
        }
        return response;
      },
    },
    recall: (_query, max) => entries.slice(-max),
  };
}

function createStubPermissionsMiddleware(options: {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}): KoiMiddleware {
  return {
    name: "koi:permissions",
    priority: 100,
    async wrapToolCall(_ctx, req, next) {
      if (options.deny.includes(req.toolId)) {
        throw Object.assign(new Error(`Permission denied: ${req.toolId}`), {
          code: "PERMISSION",
        });
      }
      return next(req);
    },
  };
}

function composeModelChain(
  middlewares: readonly KoiMiddleware[],
  ctx: TurnContext,
  innerHandler: ModelHandler,
): ModelHandler {
  const sorted = [...middlewares]
    .filter((mw) => mw.wrapModelCall)
    .sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500));
  let handler = innerHandler;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const mw = sorted[i];
    if (mw === undefined) continue;
    const nextHandler = handler;
    handler = (req: ModelRequest) => mw.wrapModelCall?.(ctx, req, nextHandler);
  }
  return handler;
}

function composeToolChain(
  middlewares: readonly KoiMiddleware[],
  ctx: TurnContext,
  innerHandler: ToolHandler,
): ToolHandler {
  const sorted = [...middlewares]
    .filter((mw) => mw.wrapToolCall)
    .sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500));
  let handler = innerHandler;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const mw = sorted[i];
    if (mw === undefined) continue;
    const nextHandler = handler;
    handler = (req: ToolRequest) => mw.wrapToolCall?.(ctx, req, nextHandler);
  }
  return handler;
}

describe("Full pipeline scenario", () => {
  function createFullStack(): {
    readonly middlewares: readonly KoiMiddleware[];
    readonly sink: ReturnType<typeof createInMemoryAuditSink>;
    readonly tracker: ReturnType<typeof createInMemoryBudgetTracker>;
    readonly memoryRecall: (query: string, max: number) => readonly StubMemoryEntry[];
  } {
    const sink = createInMemoryAuditSink();
    const tracker = createInMemoryBudgetTracker();
    const { middleware: memory, recall } = createStubMemoryMiddleware();

    const perm = createStubPermissionsMiddleware({ allow: ["*"], deny: ["blocked"] });

    const pay = createPayMiddleware({
      tracker,
      calculator: createDefaultCostCalculator(),
      budget: 100,
    });

    const audit = createAuditMiddleware({ sink });

    return {
      middlewares: [perm, pay, audit, memory],
      sink,
      tracker,
      memoryRecall: recall,
    };
  }

  test("full model call pipeline -- all middleware participate", async () => {
    const { middlewares, sink, tracker } = createFullStack();
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler({
      content: "result",
      model: "test-model",
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const chain = composeModelChain(middlewares, ctx, spy.handler);
    const response = await chain({ messages: [] });

    // Response should pass through
    expect(response.content).toBe("result");
    expect(spy.calls).toHaveLength(1);

    // Pay should have recorded cost — total spend increased
    const spent = await tracker.totalSpend(ctx.session.sessionId);
    expect(spent).toBeGreaterThan(0);

    // Audit should have logged
    await new Promise((r) => setTimeout(r, 20));
    expect(sink.entries.length).toBeGreaterThanOrEqual(1);
    const modelEntry = sink.entries.find((e) => e.kind === "model_call");
    expect(modelEntry).toBeDefined();
  });

  test("full tool call pipeline -- permission check + budget check", async () => {
    const { middlewares } = createFullStack();
    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler();

    const chain = composeToolChain(middlewares, ctx, spy.handler);
    const response = await chain({ toolId: "allowed-tool", input: {} });

    expect(response.output).toEqual({ result: "mock" });
    expect(spy.calls).toHaveLength(1);
  });

  test("blocked tool denied by permissions, never reaches inner layers", async () => {
    const { middlewares, tracker } = createFullStack();
    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler();

    const chain = composeToolChain(middlewares, ctx, spy.handler);
    try {
      await chain({ toolId: "blocked", input: {} });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as { readonly code: string };
      expect(err.code).toBe("PERMISSION");
    }
    // Tool never executed
    expect(spy.calls).toHaveLength(0);
    // Pay never recorded — spend is zero
    const spent = await tracker.totalSpend(ctx.session.sessionId);
    expect(spent).toBe(0);
  });

  test("session lifecycle -- start and end fire session hooks", async () => {
    const { middlewares, sink } = createFullStack();
    const sessionCtx = createMockSessionContext();

    // Fire onSessionStart on all middleware
    for (const mw of middlewares) {
      if (mw.onSessionStart) await mw.onSessionStart(sessionCtx);
    }

    await new Promise((r) => setTimeout(r, 20));
    const startEntries = sink.entries.filter((e) => e.kind === "session_start");
    expect(startEntries).toHaveLength(1);

    // Fire onSessionEnd on all middleware
    for (const mw of middlewares) {
      if (mw.onSessionEnd) await mw.onSessionEnd(sessionCtx);
    }

    await new Promise((r) => setTimeout(r, 20));
    const endEntries = sink.entries.filter((e) => e.kind === "session_end");
    expect(endEntries).toHaveLength(1);
  });

  test("multi-turn session -- memory accumulates across turns", async () => {
    const { middlewares, memoryRecall } = createFullStack();

    // Turn 0
    const ctx0 = createMockTurnContext({ turnIndex: 0 });
    const spy0 = createSpyModelHandler({ content: "Turn 0 response" });
    const chain0 = composeModelChain(middlewares, ctx0, spy0.handler);
    await chain0({
      messages: [
        { senderId: "user-1", timestamp: Date.now(), content: [{ kind: "text", text: "Hello" }] },
      ],
    });

    // Turn 1 -- should have memory from turn 0
    const ctx1 = createMockTurnContext({ turnIndex: 1 });
    const spy1 = createSpyModelHandler({ content: "Turn 1 response" });
    const chain1 = composeModelChain(middlewares, ctx1, spy1.handler);
    await chain1({
      messages: [
        {
          senderId: "user-1",
          timestamp: Date.now(),
          content: [{ kind: "text", text: "Follow up" }],
        },
      ],
    });

    // Memory store should have accumulated
    const recalled = memoryRecall("test", 4000);
    expect(recalled.length).toBeGreaterThanOrEqual(2);
  });

  test("error recovery -- tool throws, chain unwinds correctly", async () => {
    const sink = createInMemoryAuditSink();
    const audit = createAuditMiddleware({ sink });

    const failingTool: ToolHandler = async () => {
      throw new Error("tool exploded");
    };

    const ctx = createMockTurnContext();
    const chain = composeToolChain([audit], ctx, failingTool);

    try {
      await chain({ toolId: "boom", input: {} });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).toBe("tool exploded");
    }

    // Audit should still log the error
    await new Promise((r) => setTimeout(r, 20));
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.error).toBeDefined();
  });

  test("all middleware names are unique", () => {
    const { middlewares } = createFullStack();
    const names = middlewares.map((mw) => mw.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  test("all middleware have defined priorities", () => {
    const { middlewares } = createFullStack();
    for (const mw of middlewares) {
      expect(mw.priority).toBeDefined();
      expect(typeof mw.priority).toBe("number");
    }
  });

  test("priorities are distinct (no collisions)", () => {
    const { middlewares } = createFullStack();
    const priorities = middlewares.map((mw) => mw.priority);
    const uniquePriorities = new Set(priorities);
    expect(uniquePriorities.size).toBe(priorities.length);
  });

  test("budget exhaustion mid-session blocks further model calls", async () => {
    const tracker = createInMemoryBudgetTracker();
    const pay = createPayMiddleware({
      tracker,
      calculator: createDefaultCostCalculator({
        expensive: { input: 1, output: 1 }, // $1 per token
      }),
      budget: 0.01, // Very small budget
    });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler({
      content: "hi",
      model: "expensive",
      usage: { inputTokens: 100, outputTokens: 100 },
    });

    // First call should succeed but exhaust budget
    const chain = composeModelChain([pay], ctx, spy.handler);
    await chain({ messages: [] });

    // Second call should fail
    try {
      await chain({ messages: [] });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as { readonly code: string };
      expect(err.code).toBe("RATE_LIMIT");
    }
  });
});
