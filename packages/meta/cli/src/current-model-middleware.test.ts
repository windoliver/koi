import { describe, expect, test } from "bun:test";
import type { ModelChunk, ModelRequest, TurnContext } from "@koi/core";
import { createCurrentModelMiddleware } from "./current-model-middleware.js";

function emptyRequest(): ModelRequest {
  return { messages: [] };
}

function stubTurnContext(): TurnContext {
  return {
    session: {
      agentId: "a",
      sessionId: "s" as TurnContext["session"]["sessionId"],
      runId: "r" as TurnContext["session"]["runId"],
      metadata: {},
    },
    turnIndex: 0,
    turnId: "t" as TurnContext["turnId"],
    messages: [],
    metadata: {},
  };
}

describe("current-model middleware", () => {
  test("rewrites request.model to box.current before calling next", async () => {
    const { middleware, box } = createCurrentModelMiddleware("anthropic/claude-sonnet-4-6");
    let seenModel: string | undefined;
    async function* next(req: ModelRequest): AsyncIterable<ModelChunk> {
      seenModel = req.model;
      yield { kind: "text_delta", delta: "" };
    }

    if (middleware.wrapModelStream === undefined) {
      throw new Error("expected wrapModelStream wrapper");
    }

    const ctx = stubTurnContext();
    const stream1 = middleware.wrapModelStream(ctx, emptyRequest(), next);
    for await (const _ of stream1) {
      /* drain */
    }
    expect(seenModel).toBe("anthropic/claude-sonnet-4-6");

    box.current = "anthropic/claude-opus-4-7";
    const stream2 = middleware.wrapModelStream(ctx, emptyRequest(), next);
    for await (const _ of stream2) {
      /* drain */
    }
    expect(seenModel).toBe("anthropic/claude-opus-4-7");
  });

  test("preserves other request fields when overriding model", async () => {
    const { middleware } = createCurrentModelMiddleware("provider/model-a");
    let captured: ModelRequest | undefined;
    async function* next(req: ModelRequest): AsyncIterable<ModelChunk> {
      captured = req;
      yield { kind: "text_delta", delta: "" };
    }
    if (middleware.wrapModelStream === undefined) {
      throw new Error("expected wrapModelStream wrapper");
    }
    const original: ModelRequest = {
      messages: [],
      temperature: 0.3,
      maxTokens: 128,
      model: "original/model",
    };
    const stream = middleware.wrapModelStream(stubTurnContext(), original, next);
    for await (const _ of stream) {
      /* drain */
    }
    expect(captured?.model).toBe("provider/model-a");
    expect(captured?.temperature).toBe(0.3);
    expect(captured?.maxTokens).toBe(128);
  });

  test("middleware has a stable name", () => {
    const { middleware } = createCurrentModelMiddleware("m");
    expect(middleware.name).toBe("current-model");
  });
});
