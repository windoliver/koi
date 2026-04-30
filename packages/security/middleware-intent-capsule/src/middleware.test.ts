import { beforeEach, describe, expect, it, mock } from "bun:test";
import { sessionId } from "@koi/core";
import type { CapsuleVerifier, CapsuleVerifyResult, IntentCapsule } from "@koi/core/intent-capsule";
import type {
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
