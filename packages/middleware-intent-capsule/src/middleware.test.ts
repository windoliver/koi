import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { CapsuleVerifier, CapsuleVerifyResult, IntentCapsule } from "@koi/core/intent-capsule";
import type {
  ModelChunk,
  ModelRequest,
  ModelResponse,
  SessionContext,
  TurnContext,
} from "@koi/core/middleware";
import { createIntentCapsuleMiddleware } from "./middleware.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSessionCtx(overrides?: Partial<SessionContext>): SessionContext {
  return {
    agentId: "agent-test-1",
    sessionId: "session-abc" as SessionContext["sessionId"],
    runId: "run-1" as SessionContext["runId"],
    metadata: {},
    ...overrides,
  };
}

function makeTurnCtx(sessionCtx: SessionContext): TurnContext {
  return {
    session: sessionCtx,
    turnIndex: 0,
    turnId: "turn-1" as TurnContext["turnId"],
    messages: [],
    metadata: {},
  };
}

function makeModelRequest(overrides?: Partial<ModelRequest>): ModelRequest {
  return {
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [{ kind: "text", text: "Hello" }],
      },
    ],
    ...overrides,
  };
}

const mockModelResponse: ModelResponse = {
  content: "I can help with that.",
  model: "test-model",
};

const nextFn = mock(async (_req: ModelRequest): Promise<ModelResponse> => mockModelResponse);

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("happy path", () => {
  beforeEach(() => nextFn.mockClear());

  it("creates capsule at onSessionStart and passes wrapModelCall", async () => {
    const mw = createIntentCapsuleMiddleware({
      systemPrompt: "You are a test agent.",
      objectives: ["Answer questions"],
    });

    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const turn = makeTurnCtx(ctx);
    const request = makeModelRequest();
    const response = await mw.wrapModelCall?.(turn, request, nextFn);

    expect(response.content).toBe("I can help with that.");
    expect(nextFn).toHaveBeenCalledTimes(1);
  });

  it("passes when objectives are empty", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Minimal agent." });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const turn = makeTurnCtx(ctx);
    await expect(mw.wrapModelCall?.(turn, makeModelRequest(), nextFn)).resolves.toBeDefined();
  });

  it("works across multiple sequential turns", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Sequential turns agent." });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    for (let i = 0; i < 3; i++) {
      const turn = { ...makeTurnCtx(ctx), turnIndex: i };
      await expect(mw.wrapModelCall?.(turn, makeModelRequest(), nextFn)).resolves.toBeDefined();
    }
    expect(nextFn).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Violation path — injectable verifier (decision 10-A)
// ---------------------------------------------------------------------------

describe("CAPSULE_VIOLATION via injectable verifier", () => {
  beforeEach(() => nextFn.mockClear());

  it("throws PERMISSION error with reason=capsule_violation when verifier returns ok=false", async () => {
    const mockVerifier: CapsuleVerifier = {
      verify(_capsule: IntentCapsule, _hash: string): CapsuleVerifyResult {
        return { ok: false, reason: "mandate_hash_mismatch" };
      },
    };

    const mw = createIntentCapsuleMiddleware({
      systemPrompt: "Original mission.",
      verifier: mockVerifier,
    });

    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const turn = makeTurnCtx(ctx);
    await expect(mw.wrapModelCall?.(turn, makeModelRequest(), nextFn)).rejects.toMatchObject({
      code: "PERMISSION",
      context: expect.objectContaining({ reason: "capsule_violation" }),
    });
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("throws when capsule_not_found (missing onSessionStart)", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Agent." });
    // Note: no onSessionStart called
    const ctx = makeSessionCtx();
    const turn = makeTurnCtx(ctx);

    await expect(mw.wrapModelCall?.(turn, makeModelRequest(), nextFn)).rejects.toMatchObject({
      code: "PERMISSION",
      context: expect.objectContaining({ detail: "capsule_not_found" }),
    });
  });

  it("includes capsuleId and sessionId in the error context", async () => {
    const mockVerifier: CapsuleVerifier = {
      verify(_c: IntentCapsule, _h: string): CapsuleVerifyResult {
        return { ok: false, reason: "mandate_hash_mismatch" };
      },
    };

    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Agent.", verifier: mockVerifier });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const turn = makeTurnCtx(ctx);
    let thrownError: unknown;
    try {
      await mw.wrapModelCall?.(turn, makeModelRequest(), nextFn);
    } catch (e) {
      thrownError = e;
    }

    expect(thrownError).toMatchObject({
      context: expect.objectContaining({
        sessionId: "session-abc",
        capsuleId: expect.stringContaining("agent-test-1"),
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle invariants (decision 11-A)
// ---------------------------------------------------------------------------

describe("session lifecycle — cleanup", () => {
  it("cleans up session state on onSessionEnd", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Cleanup test." });
    const ctx = makeSessionCtx();

    await mw.onSessionStart?.(ctx);
    await mw.onSessionEnd?.(ctx);

    // After cleanup, a model call should fail with capsule_not_found
    const turn = makeTurnCtx(ctx);
    await expect(mw.wrapModelCall?.(turn, makeModelRequest(), nextFn)).rejects.toMatchObject({
      context: expect.objectContaining({ detail: "capsule_not_found" }),
    });
  });
});

describe("session lifecycle — TTL eviction", () => {
  it("evicts stale sessions on the next onSessionStart", async () => {
    const mw = createIntentCapsuleMiddleware({
      systemPrompt: "TTL test.",
      maxTtlMs: 1_000, // 1 second TTL
    });

    const staleCtx = makeSessionCtx({ sessionId: "session-stale" as SessionContext["sessionId"] });
    await mw.onSessionStart?.(staleCtx);

    // Advance time past the TTL (spyOn Date.now)
    const nowSpy = spyOn(Date, "now").mockReturnValue(Date.now() + 2_000);

    try {
      // New session start triggers eviction
      const freshCtx = makeSessionCtx({
        sessionId: "session-fresh" as SessionContext["sessionId"],
      });
      await mw.onSessionStart?.(freshCtx);

      // Stale session's capsule should have been evicted
      const staleTurn = makeTurnCtx(staleCtx);
      await expect(mw.wrapModelCall?.(staleTurn, makeModelRequest(), nextFn)).rejects.toMatchObject(
        {
          context: expect.objectContaining({ detail: "capsule_not_found" }),
        },
      );
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("session lifecycle — concurrent sessions", () => {
  it("isolates capsules across concurrent sessions", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Concurrent test." });

    const ctxA = makeSessionCtx({ sessionId: "session-A" as SessionContext["sessionId"] });
    const ctxB = makeSessionCtx({ sessionId: "session-B" as SessionContext["sessionId"] });

    // Start both sessions in parallel
    await Promise.all([mw.onSessionStart?.(ctxA), mw.onSessionStart?.(ctxB)]);

    // End session A only
    await mw.onSessionEnd?.(ctxA);

    // Session A's turns should fail (evicted)
    const turnA = makeTurnCtx(ctxA);
    await expect(mw.wrapModelCall?.(turnA, makeModelRequest(), nextFn)).rejects.toMatchObject({
      context: expect.objectContaining({ detail: "capsule_not_found" }),
    });

    // Session B's turns should still pass
    const turnB = makeTurnCtx(ctxB);
    await expect(mw.wrapModelCall?.(turnB, makeModelRequest(), nextFn)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Streaming path
// ---------------------------------------------------------------------------

describe("wrapModelStream", () => {
  it("yields chunks on valid capsule", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Stream agent." });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const chunks: ModelChunk[] = [];
    const streamNext = mock(async function* (_req: ModelRequest): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "Hello " };
      yield { kind: "text_delta", delta: "world" };
      yield {
        kind: "done",
        response: { content: "Hello world", model: "test-model" },
      };
    });

    const turn = makeTurnCtx(ctx);
    const { wrapModelStream } = mw;
    if (!wrapModelStream) throw new Error("wrapModelStream should be defined");
    for await (const chunk of wrapModelStream(turn, makeModelRequest(), streamNext)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ kind: "text_delta", delta: "Hello " });
  });

  it("throws CAPSULE_VIOLATION on stream when verifier rejects", async () => {
    const mockVerifier: CapsuleVerifier = {
      verify(): CapsuleVerifyResult {
        return { ok: false, reason: "mandate_hash_mismatch" };
      },
    };
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Agent.", verifier: mockVerifier });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const turn = makeTurnCtx(ctx);
    const streamNext = mock(async function* (): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "should not reach" };
    });

    const { wrapModelStream } = mw;
    if (!wrapModelStream) throw new Error("wrapModelStream should be defined");
    await expect(async () => {
      for await (const _chunk of wrapModelStream(turn, makeModelRequest(), streamNext)) {
        // consume
      }
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// injectMandate option
// ---------------------------------------------------------------------------

describe("injectMandate", () => {
  beforeEach(() => nextFn.mockClear());

  it("prepends a signed mandate message when injectMandate=true", async () => {
    let capturedRequest: ModelRequest | undefined;
    const capturingNext = mock(async (req: ModelRequest): Promise<ModelResponse> => {
      capturedRequest = req;
      return mockModelResponse;
    });

    const mw = createIntentCapsuleMiddleware({
      systemPrompt: "My mission.",
      injectMandate: true,
    });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    await mw.wrapModelCall?.(makeTurnCtx(ctx), makeModelRequest(), capturingNext);

    expect(capturedRequest?.messages[0]?.senderId).toBe("system:intent-capsule");
    expect(capturedRequest?.messages[0]?.content[0]).toMatchObject({
      kind: "text",
      text: expect.stringContaining("[Signed Mandate — v1]"),
    });
  });

  it("does not inject when injectMandate=false (default)", async () => {
    let capturedRequest: ModelRequest | undefined;
    const capturingNext = mock(async (req: ModelRequest): Promise<ModelResponse> => {
      capturedRequest = req;
      return mockModelResponse;
    });

    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Agent." });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    await mw.wrapModelCall?.(makeTurnCtx(ctx), makeModelRequest(), capturingNext);

    expect(capturedRequest?.messages[0]?.senderId).not.toBe("system:intent-capsule");
  });
});
