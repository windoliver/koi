import { beforeEach, describe, expect, it, mock } from "bun:test";
import { sessionId } from "@koi/core";
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
// Fixtures
// ---------------------------------------------------------------------------

function makeSessionCtx(id = "session-abc"): SessionContext {
  return {
    agentId: "agent-test-1",
    sessionId: sessionId(id),
    runId: "run-1" as never,
    metadata: {},
  };
}

function makeTurnCtx(ctx: SessionContext): TurnContext {
  return {
    session: ctx,
    turnIndex: 0,
    turnId: "turn-1" as never,
    messages: [],
    metadata: {},
  };
}

function makeModelRequest(): ModelRequest {
  return {
    messages: [
      {
        senderId: "user",
        timestamp: Date.now(),
        content: [{ kind: "text", text: "Hello" }],
      },
    ],
  };
}

const mockResponse: ModelResponse = { content: "OK", model: "test-model" };
const nextFn = mock(async (_req: ModelRequest): Promise<ModelResponse> => mockResponse);

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
    const response = await mw.wrapModelCall?.(turn, makeModelRequest(), nextFn);
    expect(response?.content).toBe("OK");
    expect(nextFn).toHaveBeenCalledTimes(1);
  });

  it("passes when objectives are empty", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Minimal agent." });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);
    const turn = makeTurnCtx(ctx);
    await expect(mw.wrapModelCall?.(turn, makeModelRequest(), nextFn)).resolves.toBeDefined();
  });

  it("passes across multiple sequential turns", async () => {
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
// Violation path — injectable verifier
// ---------------------------------------------------------------------------

describe("CAPSULE_VIOLATION via injectable verifier", () => {
  beforeEach(() => nextFn.mockClear());

  it("throws PERMISSION with reason=capsule_violation when verifier returns ok=false", async () => {
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

  it("throws capsule_not_found when onSessionStart was never called", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Agent." });
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
    let thrown: unknown;
    try {
      await mw.wrapModelCall?.(turn, makeModelRequest(), nextFn);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toMatchObject({
      context: expect.objectContaining({
        sessionId: "session-abc",
        capsuleId: expect.stringContaining("agent-test-1"),
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe("session lifecycle — cleanup", () => {
  it("removes capsule on onSessionEnd, subsequent call throws capsule_not_found", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Cleanup test." });
    const ctx = makeSessionCtx();

    await mw.onSessionStart?.(ctx);
    await mw.onSessionEnd?.(ctx);

    const turn = makeTurnCtx(ctx);
    await expect(mw.wrapModelCall?.(turn, makeModelRequest(), nextFn)).rejects.toMatchObject({
      context: expect.objectContaining({ detail: "capsule_not_found" }),
    });
  });
});

describe("session lifecycle — TTL eviction", () => {
  it("evicts stale sessions when a new onSessionStart fires", async () => {
    const mw = createIntentCapsuleMiddleware({
      systemPrompt: "TTL test.",
      maxTtlMs: 1_000,
    });

    const staleCtx = makeSessionCtx("session-stale");
    await mw.onSessionStart?.(staleCtx);

    const origNow = Date.now;
    Date.now = () => origNow() + 2_000;

    try {
      const freshCtx = makeSessionCtx("session-fresh");
      await mw.onSessionStart?.(freshCtx);

      const staleTurn = makeTurnCtx(staleCtx);
      await expect(mw.wrapModelCall?.(staleTurn, makeModelRequest(), nextFn)).rejects.toMatchObject(
        {
          context: expect.objectContaining({ detail: "capsule_not_found" }),
        },
      );
    } finally {
      Date.now = origNow;
    }
  });
});

describe("session lifecycle — concurrent sessions", () => {
  it("isolates capsules: ending session-A does not affect session-B", async () => {
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Concurrent test." });

    const ctxA = makeSessionCtx("session-A");
    const ctxB = makeSessionCtx("session-B");

    await Promise.all([mw.onSessionStart?.(ctxA), mw.onSessionStart?.(ctxB)]);
    await mw.onSessionEnd?.(ctxA);

    const turnA = makeTurnCtx(ctxA);
    await expect(mw.wrapModelCall?.(turnA, makeModelRequest(), nextFn)).rejects.toMatchObject({
      context: expect.objectContaining({ detail: "capsule_not_found" }),
    });

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

    const streamNext = mock(async function* (_req: ModelRequest): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "Hello " };
      yield { kind: "text_delta", delta: "world" };
      yield { kind: "done", response: { content: "Hello world", model: "test" } };
    });

    const chunks: ModelChunk[] = [];
    const turn = makeTurnCtx(ctx);
    const stream = mw.wrapModelStream?.(turn, makeModelRequest(), streamNext);
    if (stream) {
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ kind: "text_delta", delta: "Hello " });
  });

  it("throws PERMISSION on stream when verifier rejects", async () => {
    const mockVerifier: CapsuleVerifier = {
      verify(): CapsuleVerifyResult {
        return { ok: false, reason: "mandate_hash_mismatch" };
      },
    };
    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Agent.", verifier: mockVerifier });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const streamNext = mock(async function* (): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "should not reach" };
    });

    const turn = makeTurnCtx(ctx);
    await expect(async () => {
      const stream = mw.wrapModelStream?.(turn, makeModelRequest(), streamNext);
      if (stream) {
        for await (const _chunk of stream) {
          // consume
        }
      }
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// injectMandate
// ---------------------------------------------------------------------------

describe("injectMandate", () => {
  beforeEach(() => nextFn.mockClear());

  it("prepends signed mandate message when injectMandate=true", async () => {
    let captured: ModelRequest | undefined;
    const capturingNext = mock(async (req: ModelRequest): Promise<ModelResponse> => {
      captured = req;
      return mockResponse;
    });

    const mw = createIntentCapsuleMiddleware({
      systemPrompt: "My mission.",
      injectMandate: true,
    });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);
    await mw.wrapModelCall?.(makeTurnCtx(ctx), makeModelRequest(), capturingNext);

    expect(captured?.messages[0]?.senderId).toBe("system:intent-capsule");
    expect(captured?.messages[0]?.content[0]).toMatchObject({
      kind: "text",
      text: expect.stringContaining("[Signed Mandate — v1]"),
    });
  });

  it("does not inject when injectMandate=false (default)", async () => {
    let captured: ModelRequest | undefined;
    const capturingNext = mock(async (req: ModelRequest): Promise<ModelResponse> => {
      captured = req;
      return mockResponse;
    });

    const mw = createIntentCapsuleMiddleware({ systemPrompt: "Agent." });
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);
    await mw.wrapModelCall?.(makeTurnCtx(ctx), makeModelRequest(), capturingNext);

    expect(captured?.messages[0]?.senderId).not.toBe("system:intent-capsule");
  });
});
