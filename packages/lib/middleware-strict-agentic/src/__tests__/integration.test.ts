import { describe, expect, test } from "bun:test";
import type { ModelResponse, SessionId, ToolCallId, TurnContext, TurnId } from "@koi/core";
import { createStrictAgenticMiddleware } from "../index.js";

/**
 * Full-loop stop-gate exercise.
 *
 * Invokes the middleware hooks in the order the engine does
 * (wrapModelCall → onBeforeStop → onAfterTurn). The goal is to document the
 * plan → block → act sequence at package-test scope without depending on
 * `@koi/engine-compose` (an L1 package that an L2 may not import).
 *
 * Cassette-based replay through the full engine runs in
 * `packages/meta/runtime/src/__tests__/golden-replay.test.ts`.
 */

function turn(sessionId: string, turnId: string): TurnContext {
  return {
    session: {
      agentId: "a",
      sessionId: sessionId as unknown as SessionId,
      runId: "r" as unknown as TurnContext["session"]["runId"],
      metadata: {},
    },
    turnIndex: 0,
    turnId: turnId as unknown as TurnId,
    messages: [],
    metadata: {},
  };
}

function planResponse(): ModelResponse {
  return { content: "I will now execute the task.", model: "m" };
}

function actResponse(): ModelResponse {
  return {
    content: "",
    model: "m",
    richContent: [
      { kind: "tool_call", id: "c1" as unknown as ToolCallId, name: "x", arguments: {} },
    ],
  };
}

describe("strict-agentic integration — plan → block → act", () => {
  test("block → re-prompt → act produces final continue", async () => {
    const { middleware } = createStrictAgenticMiddleware({});

    // Turn 1: plan-only response.
    const t1 = turn("s1", "t1");
    await middleware.wrapModelCall?.(t1, { messages: [] }, async () => planResponse());
    const r1 = await middleware.onBeforeStop?.(t1);
    expect(r1?.kind).toBe("block");
    await middleware.onAfterTurn?.(t1);

    // Turn 2: action response (simulates re-prompt success).
    const t2 = turn("s1", "t2");
    await middleware.wrapModelCall?.(t2, { messages: [] }, async () => actResponse());
    const r2 = await middleware.onBeforeStop?.(t2);
    expect(r2?.kind).toBe("continue");
    await middleware.onAfterTurn?.(t2);
  });
});
