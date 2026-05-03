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
  test("follows controller swaps across turns (one ctx per turn)", async () => {
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

    const ctx1 = { metadata: {} } as unknown as TurnContext;
    await mw.wrapModelCall?.(ctx1, { messages: [] }, handler);
    expect(captured.at(-1)?.messages.at(-1)?.senderId).toBe("a-tag");

    ctrl.swap(engineB, {
      turnId: "run-1:t1" as Parameters<typeof ctrl.swap>[1]["turnId"],
      reason: "test",
    });
    // Fresh ctx represents the next turn — pinning binds per-turn, so swaps
    // are observable on the very next turn's first prepare().
    const ctx2 = { metadata: {} } as unknown as TurnContext;
    await mw.wrapModelCall?.(ctx2, { messages: [] }, handler);
    expect(captured.at(-1)?.messages.at(-1)?.senderId).toBe("b-tag");
  });

  test("pins the engine for the duration of a turn (prepare + onAfterTurn paired)", async () => {
    // Per-turn binding regression: a swap mid-turn must not split prepare()
    // and onAfterTurn() across two engines, even though future turns will
    // see the swap.
    let aPrepareCalls = 0;
    let aAfterCalls = 0;
    let bPrepareCalls = 0;
    let bAfterCalls = 0;
    const engineA: ContextEngine = {
      identity: { name: "a", version: "1.0.0" },
      prepare: (_c, m) => {
        aPrepareCalls++;
        return m;
      },
      onAfterTurn: () => {
        aAfterCalls++;
      },
    };
    const engineB: ContextEngine = {
      identity: { name: "b", version: "1.0.0" },
      prepare: (_c, m) => {
        bPrepareCalls++;
        return m;
      },
      onAfterTurn: () => {
        bAfterCalls++;
      },
    };
    const ctrl = createContextEngineSwapController(engineA);
    const mw = createContextEngineSlotMiddleware(() => ctrl.current());

    const handler: ModelHandler = async () =>
      ({ content: "ok", model: "x" }) satisfies ModelResponse;
    const turnCtx = { metadata: {} } as unknown as TurnContext;

    await mw.wrapModelCall?.(turnCtx, { messages: [] }, handler);
    // Mid-turn swap (host calls controller.swap(); intentionally permitted by API)
    ctrl.swap(engineB, {
      turnId: "run-1:t1" as Parameters<typeof ctrl.swap>[1]["turnId"],
      reason: "mid-turn",
    });
    // Subsequent model calls within the same turn must still hit engine A.
    await mw.wrapModelCall?.(turnCtx, { messages: [] }, handler);
    await mw.onAfterTurn?.(turnCtx);

    expect(aPrepareCalls).toBe(2);
    expect(aAfterCalls).toBe(1);
    expect(bPrepareCalls).toBe(0);
    expect(bAfterCalls).toBe(0);

    // Fresh turn picks up engine B.
    const turn2 = { metadata: {} } as unknown as TurnContext;
    await mw.wrapModelCall?.(turn2, { messages: [] }, handler);
    await mw.onAfterTurn?.(turn2);
    expect(bPrepareCalls).toBe(1);
    expect(bAfterCalls).toBe(1);
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
