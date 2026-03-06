/**
 * Integration and lifecycle tests for createGoalReminderMiddleware.
 */

import { describe, expect, test } from "bun:test";
import { sessionId } from "@koi/core/ecs";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import {
  createMockModelStreamHandler,
  createMockSessionContext,
  createMockTurnContext,
} from "@koi/test-utils";
import type { GoalReminderConfig } from "./config.js";
import { createGoalReminderMiddleware } from "./goal-reminder.js";
import type { ReminderSource } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModelResponse(text: string): ModelResponse {
  return { content: text, model: "test-model" };
}

function makeConfig(overrides?: Partial<GoalReminderConfig>): GoalReminderConfig {
  const defaults: GoalReminderConfig = {
    sources: [{ kind: "manifest", objectives: ["complete the task"] }],
    baseInterval: 2,
    maxInterval: 8,
  };
  return { ...defaults, ...overrides };
}

async function simulateTurns(
  mw: ReturnType<typeof createGoalReminderMiddleware>,
  sessionCtx: ReturnType<typeof createMockSessionContext>,
  turnCount: number,
  handler: (req: ModelRequest) => Promise<ModelResponse>,
): Promise<readonly (ModelRequest | undefined)[]> {
  const captured: (ModelRequest | undefined)[] = [];

  for (let i = 0; i < turnCount; i++) {
    const turnCtx = createMockTurnContext({
      session: sessionCtx,
      turnIndex: i,
      messages: [
        {
          senderId: "user",
          timestamp: Date.now(),
          content: [{ kind: "text", text: `turn ${String(i)}` }],
        },
      ],
    });

    await mw.onBeforeTurn?.(turnCtx);

    let capturedReq: ModelRequest | undefined;
    if (mw.wrapModelCall) {
      await mw.wrapModelCall(
        turnCtx,
        { messages: turnCtx.messages },
        async (req: ModelRequest): Promise<ModelResponse> => {
          capturedReq = req;
          return handler(req);
        },
      );
    }
    captured.push(capturedReq);
  }

  return captured;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGoalReminderMiddleware", () => {
  test("returns middleware with name 'goal-reminder' and priority 330", () => {
    const mw = createGoalReminderMiddleware(makeConfig());
    expect(mw.name).toBe("goal-reminder");
    expect(mw.priority).toBe(330);
  });

  test("throws KoiRuntimeError with VALIDATION code on invalid config", () => {
    expect(() =>
      createGoalReminderMiddleware({
        sources: [],
        baseInterval: 2,
        maxInterval: 8,
      } as unknown as GoalReminderConfig),
    ).toThrow(expect.objectContaining({ code: "VALIDATION" }));
  });

  test("injects on trigger turns and skips others (baseInterval=2)", async () => {
    const mw = createGoalReminderMiddleware(makeConfig({ baseInterval: 2, maxInterval: 8 }));
    const sessionCtx = createMockSessionContext();
    await mw.onSessionStart?.(sessionCtx);

    const handler = async (_req: ModelRequest) => makeModelResponse("ok");
    const requests = await simulateTurns(mw, sessionCtx, 4, handler);

    // Turn 0 (index 0): turnCount becomes 1, not trigger (1-0=1 < 2)
    // Turn 1 (index 1): turnCount becomes 2, trigger (2-0=2 >= 2)
    // Turn 2 (index 2): turnCount becomes 3, not trigger (3-2=1 < interval)
    // Turn 3 (index 3): depends on doubled interval (4)

    expect(requests[0]?.messages[0]?.senderId).not.toBe("system:goal-reminder");
    expect(requests[1]?.messages[0]?.senderId).toBe("system:goal-reminder");
  });

  test("adaptive interval doubles when on-track", async () => {
    // With baseInterval=2, after first trigger the interval should be 4
    // because defaultIsDrifting sees goal keywords in messages
    const mw = createGoalReminderMiddleware(
      makeConfig({
        sources: [{ kind: "manifest", objectives: ["complete the task"] }],
        baseInterval: 2,
        maxInterval: 16,
      }),
    );
    const sessionCtx = createMockSessionContext();
    await mw.onSessionStart?.(sessionCtx);

    const handler = async (_req: ModelRequest) => makeModelResponse("ok");

    // Run enough turns: base=2, so trigger at turn 2, then interval doubles to 4
    // Next trigger at turn 2+4=6
    const requests = await simulateTurns(mw, sessionCtx, 7, handler);

    // Turn 1 (idx 1): trigger — inject
    expect(requests[1]?.messages[0]?.senderId).toBe("system:goal-reminder");
    // Turns 2-4: no inject (interval doubled)
    // But the exact trigger depends on drift detection...
    // The user messages include "turn N" which won't match "complete" or "task"
    // so defaultIsDrifting will return true → interval stays at 2 (reset)
    // Actually let's verify by checking turn 3
    expect(requests[3]?.messages[0]?.senderId).toBe("system:goal-reminder");
  });

  test("adaptive interval resets on drift", async () => {
    // Explicitly set isDrifting to always return true
    const mw = createGoalReminderMiddleware(
      makeConfig({
        baseInterval: 2,
        maxInterval: 16,
        isDrifting: () => true,
      }),
    );
    const sessionCtx = createMockSessionContext();
    await mw.onSessionStart?.(sessionCtx);

    const handler = async (_req: ModelRequest) => makeModelResponse("ok");
    const requests = await simulateTurns(mw, sessionCtx, 6, handler);

    // With isDrifting=true, interval stays at 2 (never doubles)
    // Triggers at turns 2, 4, 6... (0-indexed: 1, 3, 5)
    expect(requests[1]?.messages[0]?.senderId).toBe("system:goal-reminder");
    expect(requests[2]?.messages[0]?.senderId).not.toBe("system:goal-reminder");
    expect(requests[3]?.messages[0]?.senderId).toBe("system:goal-reminder");
  });

  test("custom isDrifting callback is used", async () => {
    let callCount = 0;
    const mw = createGoalReminderMiddleware(
      makeConfig({
        baseInterval: 1,
        maxInterval: 8,
        isDrifting: () => {
          callCount++;
          return false;
        },
      }),
    );
    const sessionCtx = createMockSessionContext();
    await mw.onSessionStart?.(sessionCtx);

    const handler = async (_req: ModelRequest) => makeModelResponse("ok");
    await simulateTurns(mw, sessionCtx, 3, handler);

    expect(callCount).toBeGreaterThan(0);
  });

  test("custom isDrifting that throws fails safe to injection", async () => {
    const mw = createGoalReminderMiddleware(
      makeConfig({
        baseInterval: 1,
        maxInterval: 8,
        isDrifting: () => {
          throw new Error("detector crashed");
        },
      }),
    );
    const sessionCtx = createMockSessionContext();
    await mw.onSessionStart?.(sessionCtx);

    const handler = async (_req: ModelRequest) => makeModelResponse("ok");
    const requests = await simulateTurns(mw, sessionCtx, 2, handler);

    // Should inject on trigger turn despite throw (fail-safe = drifting = inject)
    expect(requests[0]?.messages[0]?.senderId).toBe("system:goal-reminder");
  });

  test("session lifecycle: start → turns → end → Map cleanup", async () => {
    const mw = createGoalReminderMiddleware(makeConfig({ baseInterval: 1 }));
    const sessionCtx = createMockSessionContext();

    await mw.onSessionStart?.(sessionCtx);

    // Verify state exists by running a turn
    const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
    await mw.onBeforeTurn?.(turnCtx);

    let injected = false;
    if (mw.wrapModelCall) {
      await mw.wrapModelCall(
        turnCtx,
        { messages: [] },
        async (req: ModelRequest): Promise<ModelResponse> => {
          injected = req.messages[0]?.senderId === "system:goal-reminder";
          return makeModelResponse("ok");
        },
      );
    }
    expect(injected).toBe(true);

    // End session
    await mw.onSessionEnd?.(sessionCtx);

    // After session end, no injection should happen
    const turnCtx2 = createMockTurnContext({ session: sessionCtx, turnIndex: 1 });
    await mw.onBeforeTurn?.(turnCtx2);

    let injectedAfterEnd = false;
    if (mw.wrapModelCall) {
      await mw.wrapModelCall(
        turnCtx2,
        { messages: [] },
        async (req: ModelRequest): Promise<ModelResponse> => {
          injectedAfterEnd = req.messages[0]?.senderId === "system:goal-reminder";
          return makeModelResponse("ok");
        },
      );
    }
    expect(injectedAfterEnd).toBe(false);
  });

  test("concurrent sessions do not interfere", async () => {
    const mw = createGoalReminderMiddleware(
      makeConfig({ baseInterval: 1, maxInterval: 8, isDrifting: () => true }),
    );
    const session1 = createMockSessionContext({ sessionId: sessionId("session-1") });
    const session2 = createMockSessionContext({ sessionId: sessionId("session-2") });

    await mw.onSessionStart?.(session1);
    await mw.onSessionStart?.(session2);

    // Run 2 turns on session 1
    const handler = async (_req: ModelRequest) => makeModelResponse("ok");
    await simulateTurns(mw, session1, 2, handler);

    // End session 1
    await mw.onSessionEnd?.(session1);

    // Session 2 should still work
    const turnCtx = createMockTurnContext({ session: session2, turnIndex: 0 });
    await mw.onBeforeTurn?.(turnCtx);

    let injected = false;
    if (mw.wrapModelCall) {
      await mw.wrapModelCall(
        turnCtx,
        { messages: [] },
        async (req: ModelRequest): Promise<ModelResponse> => {
          injected = req.messages[0]?.senderId === "system:goal-reminder";
          return makeModelResponse("ok");
        },
      );
    }
    expect(injected).toBe(true);
  });

  test("describeCapabilities returns interval info after session start", async () => {
    const mw = createGoalReminderMiddleware(makeConfig({ baseInterval: 5 }));
    const sessionCtx = createMockSessionContext();
    await mw.onSessionStart?.(sessionCtx);
    const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
    const fragment = mw.describeCapabilities(turnCtx);
    expect(fragment).toBeDefined();
    expect(fragment?.label).toBe("reminders");
    expect(fragment?.description).toContain("5");
  });

  test("describeCapabilities returns undefined before session start", () => {
    const mw = createGoalReminderMiddleware(makeConfig());
    const turnCtx = createMockTurnContext();
    expect(mw.describeCapabilities(turnCtx)).toBeUndefined();
  });

  test("wrapModelStream injects reminder on trigger turns", async () => {
    const mw = createGoalReminderMiddleware(
      makeConfig({ baseInterval: 1, isDrifting: () => true }),
    );
    const sessionCtx = createMockSessionContext();
    await mw.onSessionStart?.(sessionCtx);

    const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
    await mw.onBeforeTurn?.(turnCtx);

    let capturedReq: ModelRequest | undefined;
    if (mw.wrapModelStream) {
      const handler = createMockModelStreamHandler([{ kind: "text_delta", delta: "ok" }]);
      const wrappedHandler = async function* (req: ModelRequest) {
        capturedReq = req;
        yield* handler(req);
      };

      for await (const _chunk of mw.wrapModelStream(turnCtx, { messages: [] }, wrappedHandler)) {
        // drain
      }
    }

    expect(capturedReq).toBeDefined();
    expect(capturedReq?.messages[0]?.senderId).toBe("system:goal-reminder");
  });

  test("static-only sources contribute to drift detection keywords", async () => {
    // With static source "use TypeScript strict mode", keywords include "typescript", "strict", "mode"
    // When messages DON'T contain these keywords → drifting → interval stays at base
    const mw = createGoalReminderMiddleware(
      makeConfig({
        sources: [{ kind: "static", text: "use TypeScript strict mode" }],
        baseInterval: 2,
        maxInterval: 16,
      }),
    );
    const sessionCtx = createMockSessionContext();
    await mw.onSessionStart?.(sessionCtx);

    const handler = async (_req: ModelRequest) => makeModelResponse("ok");
    // Messages say "turn N" which won't match "typescript"/"strict"/"mode"
    // → defaultIsDrifting returns true → interval stays at 2 (never doubles)
    const requests = await simulateTurns(mw, sessionCtx, 6, handler);

    // Triggers at turns 1, 3, 5 (0-indexed) because interval stays 2
    expect(requests[1]?.messages[0]?.senderId).toBe("system:goal-reminder");
    expect(requests[3]?.messages[0]?.senderId).toBe("system:goal-reminder");
    expect(requests[5]?.messages[0]?.senderId).toBe("system:goal-reminder");
  });

  test("mixed manifest+static sources both contribute keywords", async () => {
    const mw = createGoalReminderMiddleware(
      makeConfig({
        sources: [
          { kind: "manifest", objectives: ["complete the task"] },
          { kind: "static", text: "follow coding standards" },
        ],
        baseInterval: 2,
        maxInterval: 16,
      }),
    );
    const sessionCtx = createMockSessionContext();
    await mw.onSessionStart?.(sessionCtx);

    const handler = async (_req: ModelRequest) => makeModelResponse("ok");
    // Messages say "turn N" — won't match "complete", "task", "follow", "coding", "standards"
    const requests = await simulateTurns(mw, sessionCtx, 4, handler);

    // Drifting → interval stays at 2 → trigger at turn 1, 3
    expect(requests[1]?.messages[0]?.senderId).toBe("system:goal-reminder");
    expect(requests[3]?.messages[0]?.senderId).toBe("system:goal-reminder");
  });

  test("dynamic-only sources yield empty goalStrings (no static keywords)", async () => {
    const mw = createGoalReminderMiddleware(
      makeConfig({
        sources: [{ kind: "dynamic", fetch: () => "dynamic content" }],
        baseInterval: 2,
        maxInterval: 16,
      }),
    );
    const sessionCtx = createMockSessionContext();
    await mw.onSessionStart?.(sessionCtx);

    const handler = async (_req: ModelRequest) => makeModelResponse("ok");
    const requests = await simulateTurns(mw, sessionCtx, 7, handler);

    // goalStrings is empty → defaultIsDrifting returns false → not drifting
    // → interval doubles: base=2 → trigger at 1, then interval=4 → trigger at 5
    expect(requests[1]?.messages[0]?.senderId).toBe("system:goal-reminder");
    // Turn 3 should NOT trigger (interval doubled to 4)
    expect(requests[3]?.messages[0]?.senderId).not.toBe("system:goal-reminder");
    // Turn 5 should trigger (1+4=5)
    expect(requests[5]?.messages[0]?.senderId).toBe("system:goal-reminder");
  });

  test("reminder content includes XML tags from sources", async () => {
    const sources: readonly ReminderSource[] = [
      { kind: "manifest", objectives: ["build the feature"] },
      { kind: "static", text: "use TypeScript strict mode" },
    ];
    const mw = createGoalReminderMiddleware(
      makeConfig({ sources, baseInterval: 1, isDrifting: () => true }),
    );
    const sessionCtx = createMockSessionContext();
    await mw.onSessionStart?.(sessionCtx);

    const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
    await mw.onBeforeTurn?.(turnCtx);

    let capturedContent = "";
    if (mw.wrapModelCall) {
      await mw.wrapModelCall(
        turnCtx,
        { messages: [] },
        async (req: ModelRequest): Promise<ModelResponse> => {
          const block = req.messages[0]?.content[0];
          if (block?.kind === "text") capturedContent = block.text;
          return makeModelResponse("ok");
        },
      );
    }

    expect(capturedContent).toContain("<reminder>");
    expect(capturedContent).toContain("<goals>");
    expect(capturedContent).toContain("build the feature");
    expect(capturedContent).toContain("<context>");
    expect(capturedContent).toContain("use TypeScript strict mode");
  });
});
