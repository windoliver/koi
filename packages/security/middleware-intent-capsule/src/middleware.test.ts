import { beforeEach, describe, expect, it, mock } from "bun:test";
import { sessionId } from "@koi/core";
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
