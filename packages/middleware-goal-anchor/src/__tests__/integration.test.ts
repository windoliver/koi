/**
 * Integration test: @koi/agent-monitor + @koi/middleware-goal-anchor.
 *
 * Verifies the three key cross-middleware scenarios:
 * 1. goal_drift fires after a turn of off-target tool calls
 * 2. goal_drift is suppressed when a tool matches an objective keyword
 * 3. goal-anchor marks objectives complete from model response text
 *
 * Both middlewares share the same session/turn contexts — this mimics
 * how they are wired together in a real agent loop.
 */

import { describe, expect, test } from "bun:test";
import type { AnomalySignal } from "@koi/agent-monitor";
import { createAgentMonitorMiddleware } from "@koi/agent-monitor";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import {
  createMockSessionContext,
  createMockToolHandler,
  createMockTurnContext,
} from "@koi/test-utils";
import { createGoalAnchorMiddleware } from "../goal-anchor.js";

const OBJECTIVES = ["search the web", "write a report"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModelResponse(text: string): ModelResponse {
  return { content: text, model: "test-model" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent-monitor + goal-anchor integration", () => {
  test("goal_drift fires after a turn of off-target tool calls", async () => {
    const anomalies: AnomalySignal[] = [];

    const monitor = createAgentMonitorMiddleware({
      objectives: OBJECTIVES,
      goalDrift: { threshold: 1.0 },
      onAnomaly: (s) => {
        anomalies.push(s);
      },
    });
    const anchor = createGoalAnchorMiddleware({ objectives: OBJECTIVES });

    const sessionCtx = createMockSessionContext();
    await monitor.onSessionStart?.(sessionCtx);
    await anchor.onSessionStart?.(sessionCtx);

    // Turn 0: off-target tool (no keyword match for "search", "write", "report")
    const turnCtx0 = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
    await monitor.onBeforeTurn?.(turnCtx0);
    if (monitor.wrapToolCall) {
      await monitor.wrapToolCall(
        turnCtx0,
        { toolId: "email_send", input: {} },
        createMockToolHandler({ output: { result: "ok" } }),
      );
    }

    // Turn 1: onBeforeTurn evaluates turn 0's tool calls → goal_drift fires
    const turnCtx1 = createMockTurnContext({ session: sessionCtx, turnIndex: 1 });
    await monitor.onBeforeTurn?.(turnCtx1);

    const driftSignals = anomalies.filter((s) => s.kind === "goal_drift");
    expect(driftSignals).toHaveLength(1);
    expect(driftSignals[0]?.driftScore).toBe(1.0);
    expect(driftSignals[0]?.objectives).toEqual(OBJECTIVES);
  });

  test("goal_drift is suppressed when a tool matches an objective keyword", async () => {
    const anomalies: AnomalySignal[] = [];

    const monitor = createAgentMonitorMiddleware({
      objectives: ["search the web"],
      goalDrift: { threshold: 1.0 },
      onAnomaly: (s) => {
        anomalies.push(s);
      },
    });

    const sessionCtx = createMockSessionContext();
    await monitor.onSessionStart?.(sessionCtx);

    // Turn 0: matching tool ("web_search" contains keyword "search")
    const turnCtx0 = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
    await monitor.onBeforeTurn?.(turnCtx0);
    if (monitor.wrapToolCall) {
      await monitor.wrapToolCall(
        turnCtx0,
        { toolId: "web_search", input: {} },
        createMockToolHandler({ output: { result: "ok" } }),
      );
    }

    // Turn 1: onBeforeTurn — tool matched, so no goal_drift
    const turnCtx1 = createMockTurnContext({ session: sessionCtx, turnIndex: 1 });
    await monitor.onBeforeTurn?.(turnCtx1);

    expect(anomalies.filter((s) => s.kind === "goal_drift")).toHaveLength(0);
  });

  test("goal-anchor injects todo block into every model call", async () => {
    const anchor = createGoalAnchorMiddleware({ objectives: OBJECTIVES });

    const sessionCtx = createMockSessionContext();
    await anchor.onSessionStart?.(sessionCtx);

    const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
    let capturedRequest: ModelRequest | undefined;

    if (anchor.wrapModelCall) {
      await anchor.wrapModelCall(
        turnCtx,
        { messages: [{ senderId: "user", timestamp: 0, content: [{ kind: "text", text: "go" }] }] },
        async (req: ModelRequest): Promise<ModelResponse> => {
          capturedRequest = req;
          return makeModelResponse("ok");
        },
      );
    }

    const req = capturedRequest;
    expect(req).toBeDefined();
    if (req !== undefined) {
      expect(req.messages[0]?.senderId).toBe("system:goal-anchor");
      // Original user message preserved
      expect(req.messages[1]?.senderId).toBe("user");
      // Todo block contains all objectives as pending
      const block = req.messages[0]?.content[0];
      if (block?.kind === "text") {
        expect(block.text).toContain("- [ ] search the web");
        expect(block.text).toContain("- [ ] write a report");
      }
    }
  });

  test("goal-anchor marks objective complete from model response text", async () => {
    const completed: string[] = [];
    const anchor = createGoalAnchorMiddleware({
      objectives: ["search the web"],
      onComplete: (item) => {
        completed.push(item.text);
      },
    });

    const sessionCtx = createMockSessionContext();
    await anchor.onSessionStart?.(sessionCtx);
    const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

    if (anchor.wrapModelCall) {
      await anchor.wrapModelCall(
        turnCtx,
        { messages: [] },
        async (): Promise<ModelResponse> =>
          makeModelResponse("I completed the search for web results."),
      );
    }

    expect(completed).toContain("search the web");
  });

  test("subsequent model call shows completed item as [x]", async () => {
    const anchor = createGoalAnchorMiddleware({ objectives: ["search the web"] });

    const sessionCtx = createMockSessionContext();
    await anchor.onSessionStart?.(sessionCtx);
    const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

    // First call: trigger completion
    if (anchor.wrapModelCall) {
      await anchor.wrapModelCall(
        turnCtx,
        { messages: [] },
        async (): Promise<ModelResponse> => makeModelResponse("I finished the search task."),
      );
    }

    // Second call: todo should reflect completed state
    let capturedRequest: ModelRequest | undefined;
    if (anchor.wrapModelCall) {
      await anchor.wrapModelCall(
        turnCtx,
        { messages: [] },
        async (req: ModelRequest): Promise<ModelResponse> => {
          capturedRequest = req;
          return makeModelResponse("ok");
        },
      );
    }

    const req = capturedRequest;
    expect(req).toBeDefined();
    if (req !== undefined) {
      const block = req.messages[0]?.content[0];
      if (block?.kind === "text") {
        expect(block.text).toContain("- [x] search the web");
      }
    }
  });

  test("both middlewares clean up on session end", async () => {
    const anomalies: AnomalySignal[] = [];
    const monitor = createAgentMonitorMiddleware({
      objectives: OBJECTIVES,
      goalDrift: { threshold: 1.0 },
      onAnomaly: (s) => {
        anomalies.push(s);
      },
    });
    const anchor = createGoalAnchorMiddleware({ objectives: OBJECTIVES });

    const sessionCtx = createMockSessionContext();
    await monitor.onSessionStart?.(sessionCtx);
    await anchor.onSessionStart?.(sessionCtx);

    await monitor.onSessionEnd?.(sessionCtx);
    await anchor.onSessionEnd?.(sessionCtx);

    // Post-end: goal-anchor should pass through unmodified (no todo prepended)
    const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
    let capturedRequest: ModelRequest | undefined;
    if (anchor.wrapModelCall) {
      await anchor.wrapModelCall(
        turnCtx,
        { messages: [] },
        async (req: ModelRequest): Promise<ModelResponse> => {
          capturedRequest = req;
          return makeModelResponse("ok");
        },
      );
    }

    // No system:goal-anchor message after session end
    const req = capturedRequest;
    if (req !== undefined) {
      expect(req.messages[0]?.senderId).not.toBe("system:goal-anchor");
    }
  });
});
