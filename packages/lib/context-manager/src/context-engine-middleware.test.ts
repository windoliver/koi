/**
 * Tests for createContextEngineMiddleware — drives ContextEngine.prepare() on
 * every model call so the slot is not dead code (issue #1767, addresses
 * adversarial-review round 3 finding 1).
 */

import { describe, expect, test } from "bun:test";
import type {
  ContextEngine,
  InboundMessage,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core";
import { createContextEngineMiddleware } from "./context-engine-middleware.js";

const ctx = { metadata: {} } as unknown as TurnContext;

const baseRequest: ModelRequest = {
  messages: [{ senderId: "user", timestamp: 0, content: [{ kind: "text", text: "hello" }] }],
};

function fakeAdapter(): { handler: ModelHandler; received: ModelRequest[] } {
  const received: ModelRequest[] = [];
  const handler: ModelHandler = async (req) => {
    received.push(req);
    const response: ModelResponse = { content: "ok", model: "test" };
    return response;
  };
  return { handler, received };
}

describe("createContextEngineMiddleware", () => {
  test("calls engine.prepare and substitutes the resulting messages into the request", async () => {
    const calls: Array<{ count: number }> = [];
    const engine: ContextEngine = {
      identity: { name: "test", version: "0.0.1" },
      prepare: (_ctx, msgs) => {
        calls.push({ count: msgs.length });
        const trimmed: InboundMessage[] = [
          { senderId: "compacted", timestamp: 999, content: [{ kind: "text", text: "summary" }] },
        ];
        return trimmed;
      },
    };
    const mw = createContextEngineMiddleware(engine);
    const adapter = fakeAdapter();

    await mw.wrapModelCall?.(ctx, baseRequest, adapter.handler);

    expect(calls).toHaveLength(1);
    expect(adapter.received).toHaveLength(1);
    expect(adapter.received[0]?.messages).toHaveLength(1);
    expect(adapter.received[0]?.messages[0]?.senderId).toBe("compacted");
  });

  test("preserves all non-message fields of the request", async () => {
    const engine: ContextEngine = {
      identity: { name: "test", version: "0.0.1" },
      prepare: (_ctx, msgs) => msgs,
    };
    const mw = createContextEngineMiddleware(engine);
    const adapter = fakeAdapter();
    const request: ModelRequest = {
      ...baseRequest,
      model: "specific-model",
      temperature: 0.7,
      systemPrompt: "you are a thing",
    };

    await mw.wrapModelCall?.(ctx, request, adapter.handler);

    expect(adapter.received[0]?.model).toBe("specific-model");
    expect(adapter.received[0]?.temperature).toBe(0.7);
    expect(adapter.received[0]?.systemPrompt).toBe("you are a thing");
  });

  test("invokes engine.onAfterTurn from the matching middleware hook", async () => {
    let afterTurnCalls = 0;
    const engine: ContextEngine = {
      identity: { name: "test", version: "0.0.1" },
      prepare: (_ctx, m) => m,
      onAfterTurn: () => {
        afterTurnCalls++;
      },
    };
    const mw = createContextEngineMiddleware(engine);
    await mw.onAfterTurn?.(ctx);
    expect(afterTurnCalls).toBe(1);
  });

  test("middleware reports a stable name and a phase suitable for compaction", () => {
    const engine: ContextEngine = {
      identity: { name: "test", version: "0.0.1" },
      prepare: (_ctx, m) => m,
    };
    const mw = createContextEngineMiddleware(engine);
    expect(mw.name).toBe("context-engine");
    // Resolve phase runs after intercept (permissions) but before observe
    // (audit), so prepare() sees the request after policy decisions and the
    // observers see the post-prepared request.
    expect(mw.phase).toBe("resolve");
  });

  test("describeCapabilities returns undefined (no model-facing capability)", () => {
    const engine: ContextEngine = {
      identity: { name: "test", version: "0.0.1" },
      prepare: (_ctx, m) => m,
    };
    const mw = createContextEngineMiddleware(engine);
    expect(mw.describeCapabilities(ctx)).toBeUndefined();
  });
});
