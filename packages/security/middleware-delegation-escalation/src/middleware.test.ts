/**
 * Unit tests for createDelegationEscalationMiddleware().
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type {
  ChannelAdapter,
  DelegationEvent,
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
import { createDelegationEscalationMiddleware } from "./middleware.js";
import type { DelegationEscalationConfig, EscalationDecision } from "./types.js";

// ---------------------------------------------------------------------------
// Mock helpers
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

function createMockTurnContext(overrides?: Partial<TurnContext>): TurnContext {
  return {
    session: {
      agentId: "test-agent",
      sessionId: "test-session" as SessionId,
      runId: runId("test-run"),
      metadata: {},
    },
    turnIndex: 0,
    turnId: "test-turn" as TurnId,
    messages: [],
    metadata: {},
    ...overrides,
  };
}

function createMockModelRequest(): ModelRequest {
  return {
    messages: [
      {
        content: [{ kind: "text", text: "Hello" }],
        senderId: "user",
        timestamp: Date.now(),
      },
    ],
  };
}

function createMockModelResponse(): ModelResponse {
  return {
    content: "Response text",
    model: "test-model",
  };
}

function createTextMessage(text: string, correlationToken?: string): InboundMessage {
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

describe("createDelegationEscalationMiddleware", () => {
  const handles: Array<ReturnType<typeof createDelegationEscalationMiddleware>> = [];

  afterEach(() => {
    for (const handle of handles) {
      handle.cancel();
    }
    handles.length = 0;
  });

  function createHandle(overrides?: Partial<DelegationEscalationConfig>): ReturnType<
    typeof createDelegationEscalationMiddleware
  > & {
    readonly channel: ReturnType<typeof createMockChannel>;
  } {
    const channel = createMockChannel();
    const handle = createDelegationEscalationMiddleware({
      channel,
      isExhausted: () => false,
      issuerId: agentId("orchestrator"),
      monitoredDelegateeIds: [agentId("w1"), agentId("w2")],
      ...overrides,
      // Override channel if provided in overrides
      ...(overrides?.channel !== undefined ? {} : { channel }),
    });
    handles.push(handle);
    return { ...handle, channel };
  }

  test("passes through model call when not exhausted", async () => {
    const { middleware } = createHandle();
    const ctx = createMockTurnContext();
    const request = createMockModelRequest();
    const response = createMockModelResponse();
    const next = mock(async () => response);

    const result = await middleware.wrapModelCall?.(ctx, request, next);
    expect(result).toBe(response);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("does not arm escalation in onAfterTurn when not exhausted", async () => {
    const { middleware, channel } = createHandle();
    const ctx = createMockTurnContext();

    await middleware.onAfterTurn?.(ctx);
    expect(channel.sentMessages).toHaveLength(0);
  });

  test("arms escalation in onAfterTurn when exhausted", async () => {
    const { middleware, channel } = createHandle({ isExhausted: () => true });
    const ctx = createMockTurnContext();

    await middleware.onAfterTurn?.(ctx);
    expect(channel.sentMessages).toHaveLength(1);
    const msg = channel.sentMessages[0];
    if (msg?.content[0]?.kind === "text") {
      expect(msg.content[0].text).toContain("orchestrator");
    }
  });

  test("wrapModelCall pauses and resumes on human instruction", async () => {
    const channel = createMockChannel();
    // let: mutable — tracks exhaustion state for testing
    let exhausted = false;
    const handle = createDelegationEscalationMiddleware({
      channel,
      isExhausted: () => exhausted,
      issuerId: agentId("orchestrator"),
      monitoredDelegateeIds: [agentId("w1"), agentId("w2")],
    });
    handles.push(handle);

    const ctx = createMockTurnContext();
    const request = createMockModelRequest();
    const response = createMockModelResponse();
    const next = mock(async (req: ModelRequest) => {
      // Verify instruction was injected
      if (req.messages.length > request.messages.length) {
        const lastMsg = req.messages[req.messages.length - 1];
        if (lastMsg?.content[0]?.kind === "text") {
          expect(lastMsg.content[0].text).toContain("Try plan B");
        }
      }
      return response;
    });

    // Trigger exhaustion
    exhausted = true;
    await handle.middleware.onAfterTurn?.(ctx);
    expect(handle.isPending()).toBe(true);

    // Start model call (will block on gate)
    const callPromise = handle.middleware.wrapModelCall?.(ctx, request, next);

    // Simulate human response — include correlation token from the escalation message
    const token = getCorrelationToken(channel.sentMessages);
    await channel.simulateMessage(createTextMessage("Try plan B", token));

    const result = await callPromise;
    expect(result).toBe(response);
    expect(next).toHaveBeenCalledTimes(1);
    expect(handle.isPending()).toBe(false);
  });

  test("wrapModelCall throws on abort decision", async () => {
    const channel = createMockChannel();
    const handle = createDelegationEscalationMiddleware({
      channel,
      isExhausted: () => true,
      issuerId: agentId("orchestrator"),
      monitoredDelegateeIds: [agentId("w1")],
    });
    handles.push(handle);

    const ctx = createMockTurnContext();
    await handle.middleware.onAfterTurn?.(ctx);

    const callPromise = handle.middleware.wrapModelCall?.(ctx, createMockModelRequest(), async () =>
      createMockModelResponse(),
    );

    const abortToken = getCorrelationToken(channel.sentMessages);
    await channel.simulateMessage(createTextMessage("abort", abortToken));

    await expect(callPromise).rejects.toThrow("Delegation escalation aborted");
  });

  test("prevents double-arming when gate is already pending", async () => {
    const { middleware, channel } = createHandle({ isExhausted: () => true });
    const ctx = createMockTurnContext();

    await middleware.onAfterTurn?.(ctx);
    expect(channel.sentMessages).toHaveLength(1);

    // Second call should not arm again
    await middleware.onAfterTurn?.(ctx);
    expect(channel.sentMessages).toHaveLength(1);
  });

  test("isPending reflects gate state", async () => {
    const channel = createMockChannel();
    const handle = createDelegationEscalationMiddleware({
      channel,
      isExhausted: () => true,
      issuerId: agentId("orchestrator"),
      monitoredDelegateeIds: [agentId("w1")],
    });
    handles.push(handle);

    expect(handle.isPending()).toBe(false);

    const ctx = createMockTurnContext();
    await handle.middleware.onAfterTurn?.(ctx);
    expect(handle.isPending()).toBe(true);

    handle.cancel();
    // Give the cancel a tick to resolve
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handle.isPending()).toBe(false);
  });

  test("fires onEscalation callback with decision", async () => {
    const decisions: EscalationDecision[] = [];
    const channel = createMockChannel();
    const handle = createDelegationEscalationMiddleware({
      channel,
      isExhausted: () => true,
      issuerId: agentId("orchestrator"),
      monitoredDelegateeIds: [agentId("w1")],
      onEscalation: (d) => decisions.push(d),
    });
    handles.push(handle);

    const ctx = createMockTurnContext();
    await handle.middleware.onAfterTurn?.(ctx);

    // Start wrapModelCall to drive the decision path
    const callPromise = handle.middleware.wrapModelCall?.(ctx, createMockModelRequest(), async () =>
      createMockModelResponse(),
    );
    const resumeToken = getCorrelationToken(channel.sentMessages);
    await channel.simulateMessage(createTextMessage("resume with instructions", resumeToken));
    await callPromise;

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe("resume");
  });

  test("fires onExhausted callback with delegation:exhausted event", async () => {
    const events: DelegationEvent[] = [];
    const { middleware } = createHandle({
      isExhausted: () => true,
      onExhausted: (e) => events.push(e),
    });

    const ctx = createMockTurnContext();
    await middleware.onAfterTurn?.(ctx);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("delegation:exhausted");
    if (events[0]?.kind === "delegation:exhausted") {
      expect(events[0].issuerId).toBe(agentId("orchestrator"));
      expect(events[0].delegateeIds).toEqual([agentId("w1"), agentId("w2")]);
    }
  });

  test("describeCapabilities reflects monitoring state", () => {
    const { middleware } = createHandle();
    const ctx = createMockTurnContext();

    const cap = middleware.describeCapabilities(ctx);
    expect(cap?.label).toBe("delegation-escalation");
    expect(cap?.description).toContain("monitoring 2 delegatees");
  });

  test("describeCapabilities reflects pending state", async () => {
    const { middleware } = createHandle({ isExhausted: () => true });
    const ctx = createMockTurnContext();

    await middleware.onAfterTurn?.(ctx);

    const cap = middleware.describeCapabilities(ctx);
    expect(cap?.description).toContain("awaiting human response");
  });
});
