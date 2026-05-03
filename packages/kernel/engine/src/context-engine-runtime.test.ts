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

const ctx = { metadata: {}, turnId: "t-default" } as unknown as TurnContext;

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
    const mw = createContextEngineSlotMiddleware(ctrl);

    const captured: ModelRequest[] = [];
    const handler: ModelHandler = async (req) => {
      captured.push(req);
      return { content: "ok", model: "x" } satisfies ModelResponse;
    };

    const ctx1 = { metadata: {}, turnId: "t-1" } as unknown as TurnContext;
    await mw.wrapModelCall?.(ctx1, { messages: [] }, handler);
    expect(captured.at(-1)?.messages.at(-1)?.senderId).toBe("a-tag");

    ctrl.swap(engineB, {
      turnId: "run-1:t1" as Parameters<typeof ctrl.swap>[1]["turnId"],
      reason: "test",
    });
    // Fresh ctx represents the next turn — pinning binds per-turn, so swaps
    // are observable on the very next turn's first prepare().
    const ctx2 = { metadata: {}, turnId: "t-2" } as unknown as TurnContext;
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
    const mw = createContextEngineSlotMiddleware(ctrl);

    const handler: ModelHandler = async () =>
      ({ content: "ok", model: "x" }) satisfies ModelResponse;

    // Distinct ctx objects sharing the same turnId — mirrors the runtime's
    // separate TurnContext instances for prepare and onAfterTurn.
    const prepCtx = { metadata: {}, turnId: "t-pin" } as unknown as TurnContext;
    const endCtx = { metadata: {}, turnId: "t-pin" } as unknown as TurnContext;
    await mw.wrapModelCall?.(prepCtx, { messages: [] }, handler);
    // Mid-turn swap (host calls controller.swap(); intentionally permitted by API)
    ctrl.swap(engineB, {
      turnId: "run-1:t1" as Parameters<typeof ctrl.swap>[1]["turnId"],
      reason: "mid-turn",
    });
    // Subsequent model calls within the same turn must still hit engine A.
    await mw.wrapModelCall?.(prepCtx, { messages: [] }, handler);
    await mw.onAfterTurn?.(endCtx);

    expect(aPrepareCalls).toBe(2);
    expect(aAfterCalls).toBe(1);
    expect(bPrepareCalls).toBe(0);
    expect(bAfterCalls).toBe(0);

    // Fresh turn picks up engine B.
    const turn2 = { metadata: {}, turnId: "t-pin-2" } as unknown as TurnContext;
    await mw.wrapModelCall?.(turn2, { messages: [] }, handler);
    await mw.onAfterTurn?.(turn2);
    expect(bPrepareCalls).toBe(1);
    expect(bAfterCalls).toBe(1);
  });

  test("releases the pin when prepare() throws so swaps are visible after a failed turn", async () => {
    // Round-9 regression: a thrown prepare() (or downstream model call) must
    // not leave the controller permanently pinned to the pre-failure engine.
    const failing: ContextEngine = {
      identity: { name: "fail", version: "1.0.0" },
      prepare: () => {
        throw new Error("boom");
      },
    };
    const recovery: ContextEngine = {
      identity: { name: "recovery", version: "2.0.0" },
      prepare: (_c, m) => m,
    };
    const ctrl = createContextEngineSwapController(failing);
    const mw = createContextEngineSlotMiddleware(ctrl);
    const handler: ModelHandler = async () =>
      ({ content: "ok", model: "x" }) satisfies ModelResponse;

    const turnCtx = { metadata: {}, turnId: "t-fail" } as unknown as TurnContext;
    await expect(mw.wrapModelCall?.(turnCtx, { messages: [] }, handler)).rejects.toThrow("boom");
    // After the failed turn, the controller MUST honor a fresh swap. If the
    // pin had leaked, current() would still report "fail".
    ctrl.swap(recovery, {
      turnId: "run-1:t1" as Parameters<typeof ctrl.swap>[1]["turnId"],
      reason: "recover",
    });
    expect(ctrl.current().identity.name).toBe("recovery");
  });

  test("controller.current() stays pinned mid-turn so ECS reads agree with middleware", async () => {
    // Round-8 regression: ECS reads (controller.current()) and middleware
    // execution must reference the same engine throughout a turn, even when
    // a host swaps mid-turn. Swaps only become visible after onAfterTurn
    // releases the pin.
    const engineA: ContextEngine = {
      identity: { name: "a", version: "1.0.0" },
      prepare: (_c, m) => m,
    };
    const engineB: ContextEngine = {
      identity: { name: "b", version: "2.0.0" },
      prepare: (_c, m) => m,
    };
    const ctrl = createContextEngineSwapController(engineA);
    const mw = createContextEngineSlotMiddleware(ctrl);
    const handler: ModelHandler = async () =>
      ({ content: "ok", model: "x" }) satisfies ModelResponse;

    const turnCtx = { metadata: {}, turnId: "t-mid" } as unknown as TurnContext;
    await mw.wrapModelCall?.(turnCtx, { messages: [] }, handler);
    expect(ctrl.current().identity.name).toBe("a");

    ctrl.swap(engineB, {
      turnId: "run-1:t1" as Parameters<typeof ctrl.swap>[1]["turnId"],
      reason: "mid-turn",
    });
    // Mid-turn: ECS-equivalent read MUST still return engine A, matching what
    // wrapModelCall is using.
    expect(ctrl.current().identity.name).toBe("a");

    await mw.onAfterTurn?.(turnCtx);
    // After the turn ends, the swap becomes visible to the next caller.
    expect(ctrl.current().identity.name).toBe("b");
  });

  test("noop when the controller returns no engine (slot empty)", async () => {
    const mw = createContextEngineSlotMiddleware({
      current: () => undefined,
      beginTurn: () => undefined,
      endTurn: () => undefined,
    });
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
    const mw = createContextEngineSlotMiddleware(ctrl);

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
    const mw = createContextEngineSlotMiddleware({
      current: () => undefined,
      beginTurn: () => undefined,
      endTurn: () => undefined,
    });
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
    const mw = createContextEngineSlotMiddleware({
      current: () => engine,
      beginTurn: () => undefined,
      endTurn: () => undefined,
    });
    await mw.onAfterTurn?.(ctx);
    expect(calls).toBe(1);
  });
});
