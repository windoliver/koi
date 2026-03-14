/**
 * Tests for concurrent observe middleware execution in composeModelChain / composeToolChain.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { composeModelChain, composeToolChain } from "./compose.js";

const STUB_CTX = {} as TurnContext;

const STUB_MODEL_RESPONSE: ModelResponse = {
  content: "ok",
  model: "test",
  usage: { inputTokens: 10, outputTokens: 5 },
};

const STUB_TOOL_RESPONSE: ToolResponse = {
  output: "done",
};

function modelRequest(): ModelRequest {
  return {
    messages: [
      { senderId: "user", content: [{ kind: "text", text: "hi" }], timestamp: Date.now() },
    ],
  };
}

function toolRequest(): ToolRequest {
  return { toolId: "test-tool", input: {} };
}

describe("concurrent observe — composeModelChain", () => {
  test("returns next() result even when concurrent observer throws", async () => {
    const throwingObserver: KoiMiddleware = {
      name: "throwing-observer",
      phase: "observe",
      concurrent: true,
      async wrapModelCall() {
        throw new Error("observer boom");
      },
      describeCapabilities: () => undefined,
    };

    const regularMiddleware: KoiMiddleware = {
      name: "regular",
      phase: "resolve",
      describeCapabilities: () => undefined,
    };

    const terminal = mock(async () => STUB_MODEL_RESPONSE);
    const chain = composeModelChain([regularMiddleware, throwingObserver], terminal);

    const result = await chain(STUB_CTX, modelRequest());
    expect(result.content).toBe("ok");
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  test("returns next() result without waiting for slow observer", async () => {
    let observerStarted = false;
    let observerFinished = false;

    const slowObserver: KoiMiddleware = {
      name: "slow-observer",
      phase: "observe",
      concurrent: true,
      async wrapModelCall(_ctx, _req, next) {
        observerStarted = true;
        const result = await next(_req);
        await new Promise((r) => setTimeout(r, 200));
        observerFinished = true;
        return result;
      },
      describeCapabilities: () => undefined,
    };

    const terminal = mock(async () => STUB_MODEL_RESPONSE);
    const chain = composeModelChain([slowObserver], terminal);

    const result = await chain(STUB_CTX, modelRequest());
    expect(result.content).toBe("ok");
    expect(observerStarted).toBe(true);
    // Observer hasn't finished yet — main chain returned immediately
    expect(observerFinished).toBe(false);

    // Wait for observer to finish
    await new Promise((r) => setTimeout(r, 300));
    expect(observerFinished).toBe(true);
  });

  test("non-concurrent observe middleware still runs sequentially", async () => {
    const callOrder: string[] = [];

    const sequentialObserver: KoiMiddleware = {
      name: "seq-observer",
      phase: "observe",
      // concurrent: false (default)
      async wrapModelCall(_ctx, req, next) {
        callOrder.push("observer-before");
        const result = await next(req);
        callOrder.push("observer-after");
        return result;
      },
      describeCapabilities: () => undefined,
    };

    const terminal = mock(async () => {
      callOrder.push("terminal");
      return STUB_MODEL_RESPONSE;
    });

    const chain = composeModelChain([sequentialObserver], terminal);
    await chain(STUB_CTX, modelRequest());

    expect(callOrder).toEqual(["observer-before", "terminal", "observer-after"]);
  });

  test("intercept middleware with concurrent flag is NOT concurrent", async () => {
    const callOrder: string[] = [];

    const interceptMw: KoiMiddleware = {
      name: "intercept",
      phase: "intercept",
      concurrent: true, // Should be ignored for intercept phase
      async wrapModelCall(_ctx, req, next) {
        callOrder.push("intercept-before");
        const result = await next(req);
        callOrder.push("intercept-after");
        return result;
      },
      describeCapabilities: () => undefined,
    };

    const terminal = mock(async () => {
      callOrder.push("terminal");
      return STUB_MODEL_RESPONSE;
    });

    const chain = composeModelChain([interceptMw], terminal);
    await chain(STUB_CTX, modelRequest());

    // Should run sequentially (concurrent ignored for intercept phase)
    expect(callOrder).toEqual(["intercept-before", "terminal", "intercept-after"]);
  });

  test("multiple concurrent observers all fire", async () => {
    const fired: string[] = [];

    function createObserver(name: string): KoiMiddleware {
      return {
        name,
        phase: "observe",
        concurrent: true,
        async wrapModelCall(_ctx, _req, next) {
          fired.push(name);
          return next(_req);
        },
        describeCapabilities: () => undefined,
      };
    }

    const terminal = mock(async () => STUB_MODEL_RESPONSE);
    const chain = composeModelChain(
      [createObserver("obs-1"), createObserver("obs-2"), createObserver("obs-3")],
      terminal,
    );

    await chain(STUB_CTX, modelRequest());

    // Allow microtasks to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(fired).toContain("obs-1");
    expect(fired).toContain("obs-2");
    expect(fired).toContain("obs-3");
  });

  test("concurrent calls with different contexts do not race (regression)", async () => {
    const observedContexts: string[] = [];

    const observer: KoiMiddleware = {
      name: "ctx-observer",
      phase: "observe",
      concurrent: true,
      async wrapModelCall(ctx, _req, next) {
        observedContexts.push(ctx.session.agentId);
        return next(_req);
      },
      describeCapabilities: () => undefined,
    };

    const terminal = mock(async () => {
      // Simulate async work so calls overlap
      await new Promise((r) => setTimeout(r, 10));
      return STUB_MODEL_RESPONSE;
    });

    const chain = composeModelChain([observer], terminal);

    const ctxA = { ...STUB_CTX, session: { ...STUB_CTX.session, agentId: "A" } } as TurnContext;
    const ctxB = { ...STUB_CTX, session: { ...STUB_CTX.session, agentId: "B" } } as TurnContext;

    // Fire two concurrent calls with different contexts
    const [resultA, resultB] = await Promise.all([
      chain(ctxA, modelRequest()),
      chain(ctxB, modelRequest()),
    ]);

    expect(resultA.content).toBe("ok");
    expect(resultB.content).toBe("ok");

    // Allow observers to settle
    await new Promise((r) => setTimeout(r, 20));

    // Each observer should see its own context — NOT both seeing "B"
    expect(observedContexts.sort()).toEqual(["A", "B"]);
  });
});

describe("concurrent observe — composeToolChain", () => {
  test("returns next() result even when concurrent observer throws", async () => {
    const throwingObserver: KoiMiddleware = {
      name: "throwing-tool-observer",
      phase: "observe",
      concurrent: true,
      async wrapToolCall() {
        throw new Error("tool observer boom");
      },
      describeCapabilities: () => undefined,
    };

    const terminal = mock(async () => STUB_TOOL_RESPONSE);
    const chain = composeToolChain([throwingObserver], terminal);

    const result = await chain(STUB_CTX, toolRequest());
    expect(result.output).toBe("done");
  });
});
