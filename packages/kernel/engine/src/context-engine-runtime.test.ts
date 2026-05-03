/**
 * Unit tests for the controller-backed context-engine slot wiring auto-injected
 * by createKoi (issue #1767, round 4 follow-up).
 */

import { describe, expect, test } from "bun:test";
import type {
  ContextEngine,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core";
import { createContextEngineSlotMiddleware } from "./context-engine-runtime.js";
import { createContextEngineSwapController } from "./context-engine-swap.js";

const ctx = { metadata: {} } as unknown as TurnContext;

describe("createContextEngineSlotMiddleware", () => {
  test("calls the engine returned by the controller on every model call", async () => {
    const engineA: ContextEngine = {
      identity: { name: "a", version: "1.0.0" },
      prepare: (_c, msgs) => [
        ...msgs,
        { senderId: "a-tag", timestamp: 1, content: [{ kind: "text", text: "A" }] },
      ],
    };
    const engineB: ContextEngine = {
      identity: { name: "b", version: "1.0.0" },
      prepare: (_c, msgs) => [
        ...msgs,
        { senderId: "b-tag", timestamp: 1, content: [{ kind: "text", text: "B" }] },
      ],
    };
    const ctrl = createContextEngineSwapController(engineA);
    const mw = createContextEngineSlotMiddleware(() => ctrl.current());

    const captured: ModelRequest[] = [];
    const handler: ModelHandler = async (req) => {
      captured.push(req);
      return { content: "ok", model: "x" } satisfies ModelResponse;
    };

    await mw.wrapModelCall?.(ctx, { messages: [] }, handler);
    expect(captured.at(-1)?.messages.at(-1)?.senderId).toBe("a-tag");

    // Swap engines: middleware MUST follow the controller, not stay bound
    // to the engine at construction time.
    ctrl.swap(engineB, {
      turnId: "run-1:t1" as Parameters<typeof ctrl.swap>[1]["turnId"],
      reason: "test",
    });
    await mw.wrapModelCall?.(ctx, { messages: [] }, handler);
    expect(captured.at(-1)?.messages.at(-1)?.senderId).toBe("b-tag");
  });

  test("noop when the controller returns no engine (slot empty)", async () => {
    const mw = createContextEngineSlotMiddleware(() => undefined);
    const captured: ModelRequest[] = [];
    const handler: ModelHandler = async (req) => {
      captured.push(req);
      return { content: "ok", model: "x" } satisfies ModelResponse;
    };
    const original = [
      { senderId: "user", timestamp: 0, content: [{ kind: "text" as const, text: "hi" }] },
    ];
    await mw.wrapModelCall?.(ctx, { messages: original }, handler);
    expect(captured[0]?.messages).toEqual(original);
  });

  test("bridges onAfterTurn to the current engine's hook", async () => {
    let calls = 0;
    const engine: ContextEngine = {
      identity: { name: "a", version: "1.0.0" },
      prepare: (_c, m) => m,
      onAfterTurn: () => {
        calls++;
      },
    };
    const mw = createContextEngineSlotMiddleware(() => engine);
    await mw.onAfterTurn?.(ctx);
    expect(calls).toBe(1);
  });
});
