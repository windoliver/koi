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

  test("wrapModelStream also drives engine.prepare (native streaming path)", async () => {
    type ModelChunk = import("@koi/core").ModelChunk;
    const captured: ModelRequest[] = [];
    const engine: ContextEngine = {
      identity: { name: "stream-engine", version: "1.0.0" },
      prepare: (_c, msgs) => [
        ...msgs,
        { senderId: "stream-tag", timestamp: 1, content: [{ kind: "text", text: "S" }] },
      ],
    };
    const ctrl = createContextEngineSwapController(engine);
    const mw = createContextEngineSlotMiddleware(() => ctrl.current());

    const next = (req: ModelRequest): AsyncIterable<ModelChunk> => {
      captured.push(req);
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<ModelChunk, undefined, undefined> {
          yield { kind: "text_delta", delta: "ok" };
        },
      };
    };

    if (mw.wrapModelStream === undefined) throw new Error("wrapModelStream missing");
    const stream = mw.wrapModelStream(ctx, { messages: [] }, next);
    const chunks: ModelChunk[] = [];
    for await (const c of stream) chunks.push(c);

    expect(chunks).toHaveLength(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.messages.at(-1)?.senderId).toBe("stream-tag");
  });

  test("wrapModelStream is a passthrough when slot is empty", async () => {
    type ModelChunk = import("@koi/core").ModelChunk;
    const original = [
      { senderId: "user", timestamp: 0, content: [{ kind: "text" as const, text: "hi" }] },
    ];
    const captured: ModelRequest[] = [];
    const next = (req: ModelRequest): AsyncIterable<ModelChunk> => {
      captured.push(req);
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<ModelChunk, undefined, undefined> {
          yield { kind: "text_delta", delta: "ok" };
        },
      };
    };
    const mw = createContextEngineSlotMiddleware(() => undefined);
    if (mw.wrapModelStream === undefined) throw new Error("wrapModelStream missing");
    const stream = mw.wrapModelStream(ctx, { messages: original }, next);
    for await (const _ of stream) {
      // drain
    }
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
