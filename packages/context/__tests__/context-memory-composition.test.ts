/**
 * Cross-middleware integration: context hydrator + higher-priority middleware.
 *
 * Verifies that context hydrator (priority 300) composes correctly with
 * middleware at higher priority (400+), with context system message appearing first.
 */

import { describe, expect, test } from "bun:test";
import type { KoiMiddleware, ModelHandler, ModelRequest, TurnContext } from "@koi/core";
import { createMockAgent, createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import { createContextHydrator } from "../src/hydrator.js";
import type { ContextManifestConfig } from "../src/types.js";

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

/** Stub middleware at priority 400 for composition tests. */
function createStubMiddleware(): KoiMiddleware {
  return {
    name: "stub-400",
    priority: 400,
    async wrapModelCall(_ctx, req, next) {
      return next(req);
    },
  };
}

describe("Context hydrator + higher-priority middleware composition", () => {
  test("context hydrator has lower priority (300) than middleware at 400", () => {
    const agent = createMockAgent();
    const contextMw = createContextHydrator({
      config: { sources: [{ kind: "text", text: "test" }] },
      agent,
    });
    const stubMw = createStubMiddleware();

    expect(contextMw.priority).toBe(300);
    expect(stubMw.priority).toBe(400);
    expect(contextMw.priority ?? 0).toBeLessThan(stubMw.priority ?? 0);
  });

  test("context system message appears first in composed chain", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "System policy context", label: "Policy" }],
    };

    const contextMw = createContextHydrator({ config, agent });
    const stubMw = createStubMiddleware();

    // Initialize
    const sessionCtx = { agentId: "test", sessionId: "s1", metadata: {} };
    await contextMw.onSessionStart?.(sessionCtx);

    const ctx0 = createMockTurnContext({ turnIndex: 0 });
    const spy0 = createSpyModelHandler({ content: "Turn 0 response" });
    const chain0 = composeModelChain([contextMw, stubMw], ctx0, spy0.handler);
    await chain0({
      messages: [
        { senderId: "user", timestamp: Date.now(), content: [{ kind: "text", text: "Hello" }] },
      ],
    });

    // Verify context system message is prepended
    const request0 = spy0.calls[0];
    expect(request0).toBeDefined();
    expect(request0?.messages.length).toBeGreaterThanOrEqual(2);

    // First message should be the context system message
    const firstMsg = request0?.messages[0];
    expect(firstMsg).toBeDefined();
    expect(firstMsg?.senderId).toBe("system:context");
    const textBlock = firstMsg?.content[0] as { kind: "text"; text: string };
    expect(textBlock.text).toContain("System policy context");
  });

  test("both middlewares fire session hooks independently", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "context" }],
    };

    const contextMw = createContextHydrator({ config, agent });
    const stubMw = createStubMiddleware();

    const sessionCtx = { agentId: "test", sessionId: "s1", metadata: {} };

    // Both should support onSessionStart without interfering
    await contextMw.onSessionStart?.(sessionCtx);
    if (stubMw.onSessionStart) await stubMw.onSessionStart(sessionCtx);

    // Both should support onSessionEnd without interfering
    if (contextMw.onSessionEnd) await contextMw.onSessionEnd(sessionCtx);
    if (stubMw.onSessionEnd) await stubMw.onSessionEnd(sessionCtx);
  });
});
