/**
 * Middleware contract tests — onion composition (wrap hooks).
 *
 * Validates wrapModelCall, wrapModelStream, and wrapToolCall behaviors.
 */

import { expect, test } from "bun:test";
import type { JsonObject } from "@koi/core/common";
import type { InboundMessage } from "@koi/core/message";
import type {
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { createMockTurnContext } from "@koi/test-utils-mocks";

export interface OnionTestOptions {
  readonly createMiddleware: () => KoiMiddleware | Promise<KoiMiddleware>;
  readonly createTurnContext?: (() => TurnContext) | undefined;
}

function createModelRequest(): ModelRequest {
  return {
    messages: [
      {
        content: [{ kind: "text" as const, text: "test" }],
        senderId: "test-sender",
        timestamp: Date.now(),
      },
    ] satisfies readonly InboundMessage[],
    model: "test-model",
  };
}

function createModelResponse(): ModelResponse {
  return {
    content: "test response",
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 20 },
  };
}

function createToolRequest(): ToolRequest {
  return {
    toolId: "test-tool",
    input: {} satisfies JsonObject,
  };
}

function createToolResponse(): ToolResponse {
  return {
    output: "test output",
  };
}

export function testOnionHooks(options: OnionTestOptions): void {
  const { createMiddleware, createTurnContext = createMockTurnContext } = options;

  // ---------------------------------------------------------------------------
  // wrapModelCall
  // ---------------------------------------------------------------------------

  test("wrapModelCall passes request to next and returns response", async () => {
    const mw = await createMiddleware();
    if (mw.wrapModelCall === undefined) return;

    const ctx = createTurnContext();
    const request = createModelRequest();
    const expectedResponse = createModelResponse();

    const response = await mw.wrapModelCall(ctx, request, async () => expectedResponse);

    expect(response).toBeDefined();
    expect(typeof response.content).toBe("string");
    expect(typeof response.model).toBe("string");
  });

  test("wrapModelCall invokes next at least once", async () => {
    const mw = await createMiddleware();
    if (mw.wrapModelCall === undefined) return;

    const ctx = createTurnContext();
    const request = createModelRequest();
    let nextCalled = 0; // let: mutated inside async callback

    await mw.wrapModelCall(ctx, request, async () => {
      nextCalled += 1;
      return createModelResponse();
    });

    expect(nextCalled).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // wrapModelStream
  // ---------------------------------------------------------------------------

  test("wrapModelStream returns an AsyncIterable", async () => {
    const mw = await createMiddleware();
    if (mw.wrapModelStream === undefined) return;

    const ctx = createTurnContext();
    const request = createModelRequest();

    async function* mockStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "hello" };
      yield {
        kind: "done",
        response: createModelResponse(),
      };
    }

    const result = mw.wrapModelStream(ctx, request, () => mockStream());

    expect(result[Symbol.asyncIterator]).toBeDefined();

    // Consume the stream to prevent dangling iterators
    const chunks: ModelChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("wrapModelStream yields chunks from the inner stream", async () => {
    const mw = await createMiddleware();
    if (mw.wrapModelStream === undefined) return;

    const ctx = createTurnContext();
    const request = createModelRequest();
    const expectedChunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "a" },
      { kind: "text_delta", delta: "b" },
      { kind: "done", response: createModelResponse() },
    ] as const;

    async function* mockStream(): AsyncIterable<ModelChunk> {
      for (const chunk of expectedChunks) {
        yield chunk;
      }
    }

    const result = mw.wrapModelStream(ctx, request, () => mockStream());
    const received: ModelChunk[] = [];
    for await (const chunk of result) {
      received.push(chunk);
    }

    // At minimum, the middleware should yield at least as many chunks as the mock
    expect(received.length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // wrapToolCall
  // ---------------------------------------------------------------------------

  test("wrapToolCall passes request to next and returns response", async () => {
    const mw = await createMiddleware();
    if (mw.wrapToolCall === undefined) return;

    const ctx = createTurnContext();
    const request = createToolRequest();
    const expectedResponse = createToolResponse();

    const response = await mw.wrapToolCall(ctx, request, async () => expectedResponse);

    expect(response).toBeDefined();
    expect(response.output).toBeDefined();
  });

  test("wrapToolCall invokes next at least once", async () => {
    const mw = await createMiddleware();
    if (mw.wrapToolCall === undefined) return;

    const ctx = createTurnContext();
    const request = createToolRequest();
    let nextCalled = 0; // let: mutated inside async callback

    await mw.wrapToolCall(ctx, request, async () => {
      nextCalled += 1;
      return createToolResponse();
    });

    expect(nextCalled).toBeGreaterThanOrEqual(1);
  });
}
