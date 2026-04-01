import { describe, expect, mock, test } from "bun:test";
import type { ChannelStatus, ToolRequest, ToolResponse, TurnContext } from "@koi/core";
import { runId, sessionId } from "@koi/core";
import { createMockSessionContext, createMockTurnContext } from "@koi/test-utils";
import { createTurnAckMiddleware } from "./turn-ack.js";

/** Typed sendStatus mock matching the ChannelStatus signature. */
function mockSendStatus(
  impl: (_s: ChannelStatus) => Promise<void> = () => Promise.resolve(),
): ReturnType<typeof mock<(_s: ChannelStatus) => Promise<void>>> {
  return mock(impl);
}

/** Creates a TurnContext with a mock sendStatus. */
function ctxWithStatus(turnIndex = 0, sendStatus = mockSendStatus()): TurnContext {
  return createMockTurnContext({ turnIndex, sendStatus });
}

/** Advances fake timers by the given ms. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createTurnAckMiddleware", () => {
  test("happy path: sends processing then idle for slow turn", async () => {
    const sendStatus = mockSendStatus();
    const mw = createTurnAckMiddleware({ debounceMs: 50 });
    const ctx = ctxWithStatus(0, sendStatus);

    await mw.onBeforeTurn?.(ctx);

    // Wait for debounce to fire
    await delay(80);

    // "processing" should have been sent
    expect(sendStatus).toHaveBeenCalledTimes(1);
    expect(sendStatus.mock.calls[0]?.[0]).toEqual({ kind: "processing", turnIndex: 0 });

    // Turn completes
    await mw.onAfterTurn?.(ctx);

    // "idle" should also be sent
    expect(sendStatus).toHaveBeenCalledTimes(2);
    expect(sendStatus.mock.calls[1]?.[0]).toEqual({ kind: "idle", turnIndex: 0 });
  });

  test("fast turn debounce: processing skipped, only idle sent", async () => {
    const sendStatus = mockSendStatus();
    const mw = createTurnAckMiddleware({ debounceMs: 100 });
    const ctx = ctxWithStatus(0, sendStatus);

    await mw.onBeforeTurn?.(ctx);
    // Turn completes before debounce fires
    await delay(20);
    await mw.onAfterTurn?.(ctx);

    // Wait past the debounce threshold to make sure processing doesn't fire
    await delay(150);

    // Only "idle" should have been sent (no "processing")
    expect(sendStatus).toHaveBeenCalledTimes(1);
    expect(sendStatus.mock.calls[0]?.[0]).toEqual({ kind: "idle", turnIndex: 0 });
  });

  test("slow turn: ack sent after debounce threshold", async () => {
    const sendStatus = mockSendStatus();
    const mw = createTurnAckMiddleware({ debounceMs: 50 });
    const ctx = ctxWithStatus(2, sendStatus);

    await mw.onBeforeTurn?.(ctx);

    // Not yet fired
    await delay(20);
    expect(sendStatus).toHaveBeenCalledTimes(0);

    // Now past debounce
    await delay(50);
    expect(sendStatus).toHaveBeenCalledTimes(1);
    expect(sendStatus.mock.calls[0]?.[0]).toEqual({ kind: "processing", turnIndex: 2 });

    await mw.onAfterTurn?.(ctx);
    expect(sendStatus).toHaveBeenCalledTimes(2);
  });

  test("no sendStatus: no-op, no errors", async () => {
    const mw = createTurnAckMiddleware();
    const ctx = createMockTurnContext({ turnIndex: 0 });

    // Should not throw
    await mw.onBeforeTurn?.(ctx);
    await mw.onAfterTurn?.(ctx);
  });

  test("sendStatus throws: catches and calls onError", async () => {
    const error = new Error("channel disconnected");
    const sendStatus = mockSendStatus(() => Promise.reject(error));
    const onError = mock((_e: unknown) => {});
    const mw = createTurnAckMiddleware({ debounceMs: 10, onError });
    const ctx = ctxWithStatus(0, sendStatus);

    await mw.onBeforeTurn?.(ctx);
    await delay(30);

    // Give the catch handler time to execute
    await delay(10);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe(error);

    // onAfterTurn idle also fails
    await mw.onAfterTurn?.(ctx);
    await delay(10);

    expect(onError).toHaveBeenCalledTimes(2);
  });

  test("custom debounce threshold", async () => {
    const sendStatus = mockSendStatus();
    const mw = createTurnAckMiddleware({ debounceMs: 200 });
    const ctx = ctxWithStatus(0, sendStatus);

    await mw.onBeforeTurn?.(ctx);

    // At 150ms, still within debounce — not fired
    await delay(150);
    expect(sendStatus).toHaveBeenCalledTimes(0);

    // At 250ms, past debounce — fired
    await delay(100);
    expect(sendStatus).toHaveBeenCalledTimes(1);
    expect(sendStatus.mock.calls[0]?.[0]).toEqual({ kind: "processing", turnIndex: 0 });

    await mw.onAfterTurn?.(ctx);
  });

  test("AbortController cleanup: no leaked timers", async () => {
    const sendStatus = mockSendStatus();
    const mw = createTurnAckMiddleware({ debounceMs: 100 });
    const ctx = ctxWithStatus(0, sendStatus);

    await mw.onBeforeTurn?.(ctx);
    // End turn immediately (aborts the debounce timer)
    await mw.onAfterTurn?.(ctx);

    // Wait well past debounce
    await delay(200);

    // Only "idle" should have been sent (debounce timer was aborted)
    expect(sendStatus).toHaveBeenCalledTimes(1);
    expect(sendStatus.mock.calls[0]?.[0]).toEqual({ kind: "idle", turnIndex: 0 });
  });

  test("wrapToolCall sends processing status with tool name", async () => {
    const sendStatus = mockSendStatus();
    const mw = createTurnAckMiddleware();
    const ctx = ctxWithStatus(0, sendStatus);

    const toolRequest: ToolRequest = { toolId: "web-search", input: { q: "test" } };
    const next = mock(async (_req: ToolRequest): Promise<ToolResponse> => ({ output: "result" }));

    const result = await mw.wrapToolCall?.(ctx, toolRequest, next);

    expect(result).toEqual({ output: "result" });
    expect(next).toHaveBeenCalledTimes(1);
    // Give fire-and-forget promise time to resolve
    await delay(10);
    expect(sendStatus).toHaveBeenCalledTimes(1);
    expect(sendStatus.mock.calls[0]?.[0]).toEqual({
      kind: "processing",
      turnIndex: 0,
      detail: "calling web-search",
    });
  });

  test("wrapToolCall skipped when toolStatus is false", async () => {
    const sendStatus = mockSendStatus();
    const mw = createTurnAckMiddleware({ toolStatus: false });
    const ctx = ctxWithStatus(0, sendStatus);

    const toolRequest: ToolRequest = { toolId: "calc", input: {} };
    const next = mock(async (_req: ToolRequest): Promise<ToolResponse> => ({ output: 42 }));

    await mw.wrapToolCall?.(ctx, toolRequest, next);
    await delay(10);

    expect(sendStatus).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("wrapToolCall no-ops without sendStatus", async () => {
    const mw = createTurnAckMiddleware();
    const ctx = createMockTurnContext({ turnIndex: 0 });

    const toolRequest: ToolRequest = { toolId: "calc", input: {} };
    const next = mock(async (_req: ToolRequest): Promise<ToolResponse> => ({ output: 1 }));

    const result = await mw.wrapToolCall?.(ctx, toolRequest, next);
    expect(result).toEqual({ output: 1 });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("wrapToolCall error in sendStatus does not block tool call", async () => {
    const sendStatus = mockSendStatus(() => Promise.reject(new Error("channel down")));
    const onError = mock((_e: unknown) => {});
    const mw = createTurnAckMiddleware({ onError });
    const ctx = ctxWithStatus(0, sendStatus);

    const toolRequest: ToolRequest = { toolId: "dangerous", input: {} };
    const next = mock(async (_req: ToolRequest): Promise<ToolResponse> => ({ output: "ok" }));

    const result = await mw.wrapToolCall?.(ctx, toolRequest, next);
    expect(result).toEqual({ output: "ok" });

    await delay(10);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("multiple turns: each turn gets independent ack lifecycle", async () => {
    const sendStatus = mockSendStatus();
    const mw = createTurnAckMiddleware({ debounceMs: 30 });

    // Turn 0 — slow
    const ctx0 = ctxWithStatus(0, sendStatus);
    await mw.onBeforeTurn?.(ctx0);
    await delay(60);
    await mw.onAfterTurn?.(ctx0);

    // Turn 0 should have processing + idle
    expect(sendStatus).toHaveBeenCalledTimes(2);
    expect(sendStatus.mock.calls[0]?.[0]).toEqual({ kind: "processing", turnIndex: 0 });
    expect(sendStatus.mock.calls[1]?.[0]).toEqual({ kind: "idle", turnIndex: 0 });

    // Turn 1 — fast (debounce skipped)
    const ctx1 = ctxWithStatus(1, sendStatus);
    await mw.onBeforeTurn?.(ctx1);
    await delay(5);
    await mw.onAfterTurn?.(ctx1);

    // Wait for any lingering timers
    await delay(60);

    // Turn 1 should only have idle (total: 3 calls)
    expect(sendStatus).toHaveBeenCalledTimes(3);
    expect(sendStatus.mock.calls[2]?.[0]).toEqual({ kind: "idle", turnIndex: 1 });
  });

  describe("describeCapabilities", () => {
    test("is defined on the middleware", () => {
      const mw = createTurnAckMiddleware();
      expect(mw.describeCapabilities).toBeDefined();
    });

    test("returns label 'turn-ack' and expected description", () => {
      const mw = createTurnAckMiddleware();
      const ctx = createMockTurnContext();
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.label).toBe("turn-ack");
      expect(result?.description).toBe(
        "Turn status: processing after 100ms debounce, idle on completion, per-tool status updates",
      );
    });
  });

  describe("session isolation", () => {
    test("concurrent sessions: starting turn B does not cancel session A debounce", async () => {
      const sendStatusA = mockSendStatus();
      const sendStatusB = mockSendStatus();
      const mw = createTurnAckMiddleware({ debounceMs: 50 });

      const sidA = sessionId("session-A");
      const sidB = sessionId("session-B");

      const ctxA = createMockTurnContext({
        turnIndex: 0,
        sendStatus: sendStatusA,
        session: {
          sessionId: sidA,
          runId: runId("run-A"),
          agentId: "agent-A",
          metadata: {},
        },
      });

      const ctxB = createMockTurnContext({
        turnIndex: 0,
        sendStatus: sendStatusB,
        session: {
          sessionId: sidB,
          runId: runId("run-B"),
          agentId: "agent-B",
          metadata: {},
        },
      });

      // Start session A turn
      await mw.onBeforeTurn?.(ctxA);
      // Start session B turn — must NOT cancel session A's debounce
      await mw.onBeforeTurn?.(ctxB);

      // Wait for both debounces to fire
      await delay(80);

      // Both sessions should have received "processing"
      expect(sendStatusA).toHaveBeenCalledTimes(1);
      expect(sendStatusA.mock.calls[0]?.[0]).toEqual({ kind: "processing", turnIndex: 0 });
      expect(sendStatusB).toHaveBeenCalledTimes(1);
      expect(sendStatusB.mock.calls[0]?.[0]).toEqual({ kind: "processing", turnIndex: 0 });

      // Complete both turns
      await mw.onAfterTurn?.(ctxA);
      await mw.onAfterTurn?.(ctxB);
    });

    test("onSessionEnd cleans up abort controller", async () => {
      const sendStatus = mockSendStatus();
      const mw = createTurnAckMiddleware({ debounceMs: 50 });

      const sid = sessionId("session-cleanup");
      const ctx = createMockTurnContext({
        turnIndex: 0,
        sendStatus,
        session: {
          sessionId: sid,
          runId: runId("run-cleanup"),
          agentId: "agent-cleanup",
          metadata: {},
        },
      });

      await mw.onBeforeTurn?.(ctx);
      // End session immediately — should abort the debounce timer
      await mw.onSessionEnd?.(createMockSessionContext({ sessionId: sid }));

      // Wait past debounce
      await delay(100);

      // No "processing" should have been sent (aborted by onSessionEnd)
      expect(sendStatus).toHaveBeenCalledTimes(0);
    });
  });
});
