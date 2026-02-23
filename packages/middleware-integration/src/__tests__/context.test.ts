/**
 * Cross-middleware integration: context hydrator + memory middleware.
 *
 * Verifies that context hydrator (priority 300) and memory middleware (priority 400)
 * compose correctly, with context system message appearing before memory messages.
 */

import { describe, expect, test } from "bun:test";
import type { ContextManifestConfig } from "@koi/context";
import { createContextHydrator } from "@koi/context";
import type { KoiMiddleware, ModelHandler, ModelRequest, TurnContext } from "@koi/core";
import { createInMemoryStore, createMemoryMiddleware } from "@koi/middleware-memory";
import { createMockAgent, createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";

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

describe("Context hydrator + memory middleware composition", () => {
  test("context hydrator has lower priority (300) than memory (400)", () => {
    const agent = createMockAgent();
    const contextMw = createContextHydrator({
      config: { sources: [{ kind: "text", text: "test" }] },
      agent,
    });
    const memoryMw = createMemoryMiddleware({ store: createInMemoryStore() });

    expect(contextMw.priority).toBe(300);
    expect(memoryMw.priority).toBe(400);
    expect(contextMw.priority ?? 0).toBeLessThan(memoryMw.priority ?? 0);
  });

  test("context system message appears before memory messages in composed chain", async () => {
    const agent = createMockAgent();
    const config: ContextManifestConfig = {
      sources: [{ kind: "text", text: "System policy context", label: "Policy" }],
    };

    const contextMw = createContextHydrator({ config, agent });
    const memoryMw = createMemoryMiddleware({ store: createInMemoryStore() });

    // Initialize both middlewares
    const sessionCtx = { agentId: "test", sessionId: "s1", metadata: {} };
    await contextMw.onSessionStart?.(sessionCtx);
    if (memoryMw.onSessionStart) await memoryMw.onSessionStart(sessionCtx);

    // First turn (memory records)
    const ctx0 = createMockTurnContext({ turnIndex: 0 });
    const spy0 = createSpyModelHandler({ content: "Turn 0 response" });
    const chain0 = composeModelChain([contextMw, memoryMw], ctx0, spy0.handler);
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
    const memoryMw = createMemoryMiddleware({ store: createInMemoryStore() });

    const sessionCtx = { agentId: "test", sessionId: "s1", metadata: {} };

    // Both should support onSessionStart without interfering
    await contextMw.onSessionStart?.(sessionCtx);
    if (memoryMw.onSessionStart) await memoryMw.onSessionStart(sessionCtx);

    // Both should support onSessionEnd without interfering
    if (contextMw.onSessionEnd) await contextMw.onSessionEnd(sessionCtx);
    if (memoryMw.onSessionEnd) await memoryMw.onSessionEnd(sessionCtx);
  });
});
