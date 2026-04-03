/**
 * Integration tests for the delegation-escalation middleware.
 *
 * Tests the full escalation flow: exhaustion detection → channel message →
 * human response → decision handling.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type {
  ChannelAdapter,
  InboundMessage,
  MessageHandler,
  ModelRequest,
  ModelResponse,
  OutboundMessage,
  SessionId,
  TurnContext,
  TurnId,
} from "@koi/core";
import { agentId, runId } from "@koi/core";
import { createDelegationEscalationMiddleware } from "../middleware.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockChannel(): ChannelAdapter & {
  readonly simulateMessage: (msg: InboundMessage) => Promise<void>;
  readonly sentMessages: OutboundMessage[];
} {
  const handlers: MessageHandler[] = [];
  const sentMessages: OutboundMessage[] = [];

  return {
    name: "test-channel",
    capabilities: {
      text: true,
      images: false,
      files: false,
      buttons: false,
      audio: false,
      video: false,
      threads: false,
      supportsA2ui: false,
    },
    connect: async () => {},
    disconnect: async () => {},
    send: async (msg: OutboundMessage) => {
      sentMessages.push(msg);
    },
    onMessage: (handler: MessageHandler) => {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    simulateMessage: async (msg: InboundMessage) => {
      for (const handler of [...handlers]) {
        await handler(msg);
      }
    },
    sentMessages,
  };
}

function createCtx(): TurnContext {
  return {
    session: {
      agentId: "test-agent",
      sessionId: "s1" as SessionId,
      runId: runId("r1"),
      metadata: {},
    },
    turnIndex: 0,
    turnId: "t1" as TurnId,
    messages: [],
    metadata: {},
  };
}

function createRequest(): ModelRequest {
  return {
    messages: [
      {
        content: [{ kind: "text", text: "Process data" }],
        senderId: "user",
        timestamp: Date.now(),
      },
    ],
  };
}

function textMsg(text: string, correlationToken?: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "human",
    timestamp: Date.now(),
    ...(correlationToken !== undefined ? { metadata: { correlationToken } } : {}),
  };
}

/** Extract the correlationToken from the last sent escalation message. */
function getCorrelationToken(sentMessages: readonly OutboundMessage[]): string | undefined {
  const last = sentMessages[sentMessages.length - 1];
  return (last?.metadata as Record<string, unknown> | undefined)?.correlationToken as
    | string
    | undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("delegation-escalation e2e", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) {
      fn();
    }
    cleanups.length = 0;
  });

  test("full escalation flow: exhausted → message → resume with instruction", async () => {
    const channel = createMockChannel();
    // let: mutable — simulates exhaustion state change
    let exhausted = false;

    const handle = createDelegationEscalationMiddleware({
      channel,
      isExhausted: () => exhausted,
      issuerId: agentId("supervisor"),
      monitoredDelegateeIds: [agentId("worker-1"), agentId("worker-2")],
      taskSummary: "Batch data processing job",
    });
    cleanups.push(() => handle.cancel());

    const ctx = createCtx();
    const response: ModelResponse = { content: "Done", model: "test" };
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      // Verify instruction injected
      const lastMsg = req.messages[req.messages.length - 1];
      if (lastMsg?.content[0]?.kind === "text") {
        expect(lastMsg.content[0].text).toContain("Switch to backup workers");
      }
      return response;
    };

    // Phase 1: Normal operation — no exhaustion
    const normalResult = await handle.middleware.wrapModelCall?.(
      ctx,
      createRequest(),
      async () => response,
    );
    expect(normalResult).toBe(response);

    // Phase 2: All delegatees exhausted
    exhausted = true;
    await handle.middleware.onAfterTurn?.(ctx);

    // Verify channel received escalation message
    expect(channel.sentMessages).toHaveLength(1);
    const sentMsg = channel.sentMessages[0];
    if (sentMsg?.content[0]?.kind === "text") {
      expect(sentMsg.content[0].text).toContain("worker-1");
      expect(sentMsg.content[0].text).toContain("worker-2");
      expect(sentMsg.content[0].text).toContain("Batch data processing job");
    }

    // Phase 3: Human responds with instruction (include correlation token from escalation)
    const callPromise = handle.middleware.wrapModelCall?.(ctx, createRequest(), next);
    const token1 = getCorrelationToken(channel.sentMessages);
    await channel.simulateMessage(textMsg("Switch to backup workers", token1));

    const result = await callPromise;
    expect(result).toBe(response);
    expect(handle.isPending()).toBe(false);
  });

  test("timeout flow: exhausted → message → timeout → abort", async () => {
    const channel = createMockChannel();

    const handle = createDelegationEscalationMiddleware({
      channel,
      isExhausted: () => true,
      issuerId: agentId("supervisor"),
      monitoredDelegateeIds: [agentId("worker-1")],
      escalationTimeoutMs: 50, // Short timeout for testing
    });
    cleanups.push(() => handle.cancel());

    const ctx = createCtx();
    await handle.middleware.onAfterTurn?.(ctx);
    expect(handle.isPending()).toBe(true);

    // Model call should eventually throw due to timeout
    await expect(
      handle.middleware.wrapModelCall?.(ctx, createRequest(), async () => ({
        content: "ignored",
        model: "test",
      })),
    ).rejects.toThrow("Delegation escalation aborted");
  });

  test("re-escalation after resume: can escalate again on subsequent exhaustion", async () => {
    const channel = createMockChannel();
    // let: mutable — simulates toggling exhaustion state
    let exhausted = false;

    const handle = createDelegationEscalationMiddleware({
      channel,
      isExhausted: () => exhausted,
      issuerId: agentId("supervisor"),
      monitoredDelegateeIds: [agentId("worker-1")],
    });
    cleanups.push(() => handle.cancel());

    const ctx = createCtx();
    const response: ModelResponse = { content: "OK", model: "test" };

    // First escalation
    exhausted = true;
    await handle.middleware.onAfterTurn?.(ctx);
    expect(channel.sentMessages).toHaveLength(1);

    const call1 = handle.middleware.wrapModelCall?.(ctx, createRequest(), async () => response);
    const token1 = getCorrelationToken(channel.sentMessages);
    await channel.simulateMessage(textMsg("try again", token1));
    await call1;
    expect(handle.isPending()).toBe(false);

    // Second escalation — exhaustion detected again on next turn
    await handle.middleware.onAfterTurn?.(ctx);
    expect(channel.sentMessages).toHaveLength(2);
    expect(handle.isPending()).toBe(true);

    const call2 = handle.middleware.wrapModelCall?.(ctx, createRequest(), async () => response);
    const token2 = getCorrelationToken(channel.sentMessages);
    await channel.simulateMessage(textMsg("abort", token2));
    await expect(call2).rejects.toThrow("aborted");
  });
});
