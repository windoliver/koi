import { describe, expect, test } from "bun:test";
import type { ModelAdapter, ModelChunk, ModelRequest, ModelResponse, TurnContext } from "@koi/core";
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

function stubAdapter(tag: string, seen: { model?: string }): ModelAdapter {
  return {
    id: `stub:${tag}`,
    provider: "stub",
    capabilities: {
      streaming: true,
      functionCalling: false,
      vision: false,
      jsonMode: false,
      maxContextTokens: 8192,
      maxOutputTokens: 4096,
    },
    async complete(_req: ModelRequest): Promise<ModelResponse> {
      return { content: "", model: tag };
    },
    async *stream(req: ModelRequest): AsyncIterable<ModelChunk> {
      seen.model = req.model ?? "(none)";
      yield { kind: "text_delta", delta: tag };
    },
  };
}

describe("current-model middleware", () => {
  test("passes through to next when box.current === initialModel", async () => {
    const factorySeen: { model?: string } = {};
    const { middleware } = createCurrentModelMiddleware("m0", (pickedModel) =>
      stubAdapter(`factory:${pickedModel}`, factorySeen),
    );
    let nextSeen: string | undefined;
    async function* next(req: ModelRequest): AsyncIterable<ModelChunk> {
      nextSeen = req.model;
      yield { kind: "text_delta", delta: "next" };
    }

    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");

    const stream = middleware.wrapModelStream(stubTurnContext(), emptyRequest(), next);
    const chunks: ModelChunk[] = [];
    for await (const c of stream) chunks.push(c);

    expect(nextSeen).toBeUndefined();
    expect(factorySeen.model).toBeUndefined();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ kind: "text_delta", delta: "next" });
  });

  test("short-circuits downstream when box.current differs from initialModel", async () => {
    const factorySeen: { model?: string } = {};
    const { middleware, box } = createCurrentModelMiddleware("m0", (pickedModel) =>
      stubAdapter(`factory:${pickedModel}`, factorySeen),
    );
    let nextCalled = false;
    async function* next(_req: ModelRequest): AsyncIterable<ModelChunk> {
      nextCalled = true;
      yield { kind: "text_delta", delta: "should-not-fire" };
    }
    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");

    box.current = "m1";
    const stream = middleware.wrapModelStream(stubTurnContext(), emptyRequest(), next);
    const chunks: ModelChunk[] = [];
    for await (const c of stream) chunks.push(c);

    expect(nextCalled).toBe(false);
    expect(factorySeen.model).toBe("m1");
    expect(chunks[0]).toEqual({ kind: "text_delta", delta: "factory:m1" });
  });

  test("preserves other request fields when short-circuiting to factory adapter", async () => {
    const factorySeen: { model?: string; req?: ModelRequest } = {};
    const { middleware, box } = createCurrentModelMiddleware("m0", (pickedModel) => ({
      id: `stub:${pickedModel}`,
      provider: "stub",
      capabilities: {
        streaming: true,
        functionCalling: false,
        vision: false,
        jsonMode: false,
        maxContextTokens: 8192,
        maxOutputTokens: 4096,
      },
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        return { content: "", model: pickedModel };
      },
      async *stream(req: ModelRequest): AsyncIterable<ModelChunk> {
        factorySeen.model = req.model ?? "(none)";
        factorySeen.req = req;
        yield { kind: "text_delta", delta: "" };
      },
    }));
    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");

    box.current = "m1";
    const original: ModelRequest = {
      messages: [],
      temperature: 0.3,
      maxTokens: 128,
      model: "original/model",
    };
    // biome-ignore lint/correctness/useYield: unreachable — short-circuit path never calls next.
    async function* next(_req: ModelRequest): AsyncIterable<ModelChunk> {
      throw new Error("next should not be called");
    }
    const stream = middleware.wrapModelStream(stubTurnContext(), original, next);
    for await (const _ of stream) {
      /* drain */
    }
    expect(factorySeen.req?.model).toBe("m1");
    expect(factorySeen.req?.temperature).toBe(0.3);
    expect(factorySeen.req?.maxTokens).toBe(128);
  });

  test("middleware has a stable name", () => {
    const { middleware } = createCurrentModelMiddleware("m", () => stubAdapter("m", {}));
    expect(middleware.name).toBe("current-model");
  });
});
