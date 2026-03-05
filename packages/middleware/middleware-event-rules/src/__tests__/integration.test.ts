/**
 * Integration tests — end-to-end scenarios exercising the full middleware pipeline.
 *
 * Tests use createEventRulesMiddleware directly with mock contexts,
 * validating event→rule→action flow for three real-world scenarios.
 */

import { describe, expect, mock, test } from "bun:test";
import type { RunId, SessionId, TurnId } from "@koi/core/ecs";
import type { SessionContext, ToolRequest, ToolResponse, TurnContext } from "@koi/core/middleware";
import { createEventRulesMiddleware } from "../rule-middleware.js";
import { validateEventRulesConfig } from "../rule-schema.js";
import type { ActionContext } from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function compile(rules: readonly Record<string, unknown>[]) {
  const result = validateEventRulesConfig({ rules });
  if (!result.ok) throw new Error(`Compilation failed: ${result.error.message}`);
  return result.value;
}

function makeSessionCtx(overrides?: Partial<SessionContext>): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: "sess-1" as SessionId,
    runId: "run-1" as RunId,
    metadata: {},
    ...overrides,
  };
}

function makeTurnCtx(turnIndex: number, session?: SessionContext): TurnContext {
  return {
    session: session ?? makeSessionCtx(),
    turnIndex,
    turnId: `turn-${turnIndex}` as TurnId,
    messages: [],
    metadata: {},
  };
}

function makeToolRequest(toolId: string, input: Record<string, unknown> = {}): ToolRequest {
  return { toolId, input };
}

// ---------------------------------------------------------------------------
// Scenario 1: Tool failure escalation
// ---------------------------------------------------------------------------

describe("Integration: tool failure escalation", () => {
  test("escalates after 3 tool failures within window", async () => {
    const ruleset = compile([
      {
        name: "tool-failure-escalate",
        on: "tool_call",
        match: { ok: false, toolId: { regex: "^shell_" } },
        condition: { count: 3, window: "1m" },
        actions: [
          { type: "escalate", message: "Tool {{toolId}} failed {{count}} times in {{window}}" },
        ],
        stopOnMatch: true,
      },
    ]);

    const requestEscalation = mock((_message: string) => {});
    const actionContext: ActionContext = { requestEscalation };

    // let justified: mutable clock for test
    let clock = 10_000;
    const mw = createEventRulesMiddleware({
      ruleset,
      actionContext,
      now: () => clock,
    });

    const turnCtx = makeTurnCtx(0);
    const req = makeToolRequest("shell_exec");
    const failHandler = mock(
      async () =>
        ({
          output: "error",
          metadata: { error: true },
        }) satisfies ToolResponse,
    );

    // 3 failed tool calls
    await mw.wrapToolCall?.(turnCtx, req, failHandler);
    clock += 1_000;
    await mw.wrapToolCall?.(turnCtx, req, failHandler);
    clock += 1_000;
    await mw.wrapToolCall?.(turnCtx, req, failHandler);

    expect(requestEscalation).toHaveBeenCalledTimes(1);
    // Message includes interpolated toolId
    // biome-ignore lint/style/noNonNullAssertion: safe — asserted exactly 1 call above
    const call = requestEscalation.mock.calls[0]!;
    expect(call[0]).toContain("shell_exec");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Budget warning on high turn count
// ---------------------------------------------------------------------------

describe("Integration: budget warning", () => {
  test("notifies when turnIndex >= 15", async () => {
    const ruleset = compile([
      {
        name: "budget-warning",
        on: "turn_complete",
        match: { turnIndex: { gte: 15 } },
        actions: [
          {
            type: "notify",
            channel: "status",
            message: "Turn count {{turnIndex}} — session {{sessionId}}",
          },
        ],
      },
    ]);

    const sendNotification = mock((_channel: string, _message: string) => {});
    const actionContext: ActionContext = { sendNotification };

    const mw = createEventRulesMiddleware({ ruleset, actionContext });
    const session = makeSessionCtx({ sessionId: "sess-budget" as SessionId });

    // Simulate session start
    await mw.onSessionStart?.(session);

    // Turn 14 — should not trigger
    await mw.onAfterTurn?.(makeTurnCtx(14, session));
    expect(sendNotification).toHaveBeenCalledTimes(0);

    // Turn 15 — should trigger
    await mw.onAfterTurn?.(makeTurnCtx(15, session));
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0]?.[0]).toBe("status");
    expect(sendNotification.mock.calls[0]?.[1]).toContain("15");
    expect(sendNotification.mock.calls[0]?.[1]).toContain("sess-budget");

    // Turn 20 — should also trigger
    await mw.onAfterTurn?.(makeTurnCtx(20, session));
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: skip_tool circuit-breaker
// ---------------------------------------------------------------------------

describe("Integration: skip_tool circuit-breaker", () => {
  test("blocks tool calls after skip_tool action fires", async () => {
    const ruleset = compile([
      {
        name: "block-shell",
        on: "tool_call",
        match: { ok: false, toolId: "shell_exec" },
        condition: { count: 2, window: "1m" },
        actions: [{ type: "skip_tool", toolId: "shell_exec" }],
      },
    ]);

    // let justified: mutable clock
    let clock = 10_000;
    const mw = createEventRulesMiddleware({
      ruleset,
      now: () => clock,
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const turnCtx = makeTurnCtx(0, session);
    const req = makeToolRequest("shell_exec");
    const failHandler = mock(
      async () =>
        ({
          output: "error",
          metadata: { error: true },
        }) satisfies ToolResponse,
    );

    const wrap = mw.wrapToolCall;
    expect(wrap).toBeDefined();
    if (wrap === undefined) return;

    // 1st failure — not yet blocked
    const r1 = await wrap(turnCtx, req, failHandler);
    expect(r1.metadata?.blocked).toBeUndefined();
    clock += 1_000;

    // 2nd failure — triggers skip_tool
    const r2 = await wrap(turnCtx, req, failHandler);
    expect(r2.metadata?.blocked).toBeUndefined(); // The call itself still goes through

    // 3rd attempt — should be blocked without calling handler
    const successHandler = mock(
      async () =>
        ({
          output: "success",
        }) satisfies ToolResponse,
    );
    const r3 = await wrap(turnCtx, req, successHandler);
    expect(r3.metadata?.blocked).toBe(true);
    expect(successHandler).not.toHaveBeenCalled();

    // Other tools not affected
    const otherReq = makeToolRequest("web_fetch");
    const r4 = await wrap(turnCtx, otherReq, successHandler);
    expect(r4.output).toBe("success");
  });

  test("cleans up session state on session end", async () => {
    const ruleset = compile([
      { name: "r1", on: "tool_call", actions: [{ type: "log", level: "info", message: "x" }] },
    ]);

    const mw = createEventRulesMiddleware({ ruleset });
    const session = makeSessionCtx();

    await mw.onSessionStart?.(session);
    await mw.onSessionEnd?.(session);

    // Should not throw on a fresh session after cleanup
    await mw.onSessionStart?.(session);
  });
});
