/**
 * Unit tests for squash companion middleware.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CompactionResult } from "@koi/core/context";
import type { SessionId } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { ModelRequest, SessionContext, TurnContext } from "@koi/core/middleware";
import { createSquashMiddleware } from "./squash-middleware.js";
import type { PendingQueue, PendingSquash } from "./types.js";
import { createPendingQueue } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(text: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "user",
    timestamp: Date.now(),
  };
}

function makeTurnContext(): TurnContext {
  return {
    session: {
      agentId: "agent-1",
      sessionId: "session-1" as SessionId,
      runId: "run-1" as TurnContext["session"]["runId"],
      metadata: {},
    },
    turnIndex: 0,
    turnId: "run-1:t0" as TurnContext["turnId"],
    messages: [],
    metadata: {},
  };
}

function makeModelRequest(messages: readonly InboundMessage[]): ModelRequest {
  return { messages };
}

function makeCompactionResult(messages: readonly InboundMessage[]): CompactionResult {
  return {
    messages,
    originalTokens: 100,
    compactedTokens: 20,
    strategy: "squash",
  };
}

function makePending(messages: readonly InboundMessage[]): PendingSquash {
  return { result: makeCompactionResult(messages) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSquashMiddleware", () => {
  // let justified: reset per test
  let pendingQueue: PendingQueue;

  beforeEach(() => {
    pendingQueue = createPendingQueue();
  });

  test("no pending squash: next receives original request unchanged", async () => {
    const middleware = createSquashMiddleware(pendingQueue);
    const originalMessages = [makeMessage("hello")];
    const request = makeModelRequest(originalMessages);
    const next = mock(async (_req: ModelRequest) => ({
      content: "response",
      model: "test",
      metadata: {},
    }));

    await middleware.wrapModelCall?.(makeTurnContext(), request, next);

    expect(next).toHaveBeenCalledTimes(1);
    const passedRequest = next.mock.calls[0]?.[0] as ModelRequest;
    expect(passedRequest.messages).toBe(originalMessages);
  });

  test("single pending squash: next receives replaced messages, queue emptied", async () => {
    const middleware = createSquashMiddleware(pendingQueue);
    const squashedMessages = [makeMessage("squashed summary")];
    pendingQueue.enqueue(makePending(squashedMessages));
    const request = makeModelRequest([makeMessage("original")]);
    const next = mock(async (_req: ModelRequest) => ({
      content: "response",
      model: "test",
      metadata: {},
    }));

    await middleware.wrapModelCall?.(makeTurnContext(), request, next);

    expect(pendingQueue.length).toBe(0);
    const passedRequest = next.mock.calls[0]?.[0] as ModelRequest;
    expect(passedRequest.messages).toBe(squashedMessages);
  });

  test("multiple pending squashes: last squash's messages applied", async () => {
    const middleware = createSquashMiddleware(pendingQueue);
    const firstMessages = [makeMessage("first squash")];
    const secondMessages = [makeMessage("second squash")];
    pendingQueue.enqueue(makePending(firstMessages));
    pendingQueue.enqueue(makePending(secondMessages));
    const request = makeModelRequest([makeMessage("original")]);
    const next = mock(async (_req: ModelRequest) => ({
      content: "response",
      model: "test",
      metadata: {},
    }));

    await middleware.wrapModelCall?.(makeTurnContext(), request, next);

    expect(pendingQueue.length).toBe(0);
    const passedRequest = next.mock.calls[0]?.[0] as ModelRequest;
    expect(passedRequest.messages).toBe(secondMessages);
  });

  test("wrapModelStream: applies pending squash", async () => {
    const middleware = createSquashMiddleware(pendingQueue);
    const squashedMessages = [makeMessage("squashed")];
    pendingQueue.enqueue(makePending(squashedMessages));
    const request = makeModelRequest([makeMessage("original")]);
    // let justified: captures the request received by next
    let capturedRequest: ModelRequest | undefined;
    const next = async function* (req: ModelRequest) {
      capturedRequest = req;
      yield { kind: "done" as const, response: { content: "done", model: "test" } };
    };

    const chunks: unknown[] = [];
    const stream = middleware.wrapModelStream;
    expect(stream).toBeDefined();
    if (stream !== undefined) {
      for await (const chunk of stream(makeTurnContext(), request, next)) {
        chunks.push(chunk);
      }
    }

    expect(pendingQueue.length).toBe(0);
    expect(capturedRequest?.messages).toBe(squashedMessages);
    expect(chunks).toHaveLength(1);
  });

  test("onSessionEnd clears queue", async () => {
    const middleware = createSquashMiddleware(pendingQueue);
    pendingQueue.enqueue(makePending([makeMessage("leftover")]));
    pendingQueue.enqueue(makePending([makeMessage("leftover2")]));
    expect(pendingQueue.length).toBe(2);

    const sessionCtx: SessionContext = {
      agentId: "agent-1",
      sessionId: "session-1" as SessionId,
      runId: "run-1" as SessionContext["runId"],
      metadata: {},
    };
    await middleware.onSessionEnd?.(sessionCtx);

    expect(pendingQueue.length).toBe(0);
  });

  test("describeCapabilities: returns correct label", () => {
    const middleware = createSquashMiddleware(pendingQueue);
    const cap = middleware.describeCapabilities(makeTurnContext());
    expect(cap).toBeDefined();
    expect(cap?.label).toBe("squash");
    expect(cap?.description).toContain("squash tool");
  });
});
