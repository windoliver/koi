import { describe, expect, test } from "bun:test";
import type { AgentMessage, MailboxComponent } from "@koi/core";
import { agentId, messageId } from "@koi/core";
import { waitForResponse } from "./wait-for-response.js";

// ---------------------------------------------------------------------------
// Mock mailbox factory
// ---------------------------------------------------------------------------

function createMockMailbox(): MailboxComponent & {
  readonly deliver: (message: AgentMessage) => void;
} {
  const handlers: Array<(message: AgentMessage) => void | Promise<void>> = [];

  return {
    send: async () => ({ ok: true, value: mockMessage("ignored") }),
    onMessage: (handler) => {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    list: async () => [],
    deliver: (message: AgentMessage) => {
      for (const h of [...handlers]) h(message);
    },
  };
}

function mockMessage(correlationId: string, overrides?: Partial<AgentMessage>): AgentMessage {
  return {
    id: messageId("msg-1"),
    from: agentId("sender"),
    to: agentId("receiver"),
    kind: "response",
    correlationId: messageId(correlationId),
    createdAt: new Date().toISOString(),
    type: "capability_request",
    payload: { status: "granted" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("waitForResponse", () => {
  test("resolves when matching response arrives", async () => {
    const mailbox = createMockMailbox();
    const corrId = messageId("corr-1");

    const promise = waitForResponse({
      mailbox,
      correlationId: corrId,
      timeoutMs: 5000,
    });

    // Deliver matching response
    mailbox.deliver(mockMessage("corr-1"));

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.correlationId).toBe(corrId);
    }
  });

  test("times out when no response arrives", async () => {
    const mailbox = createMockMailbox();

    const result = await waitForResponse({
      mailbox,
      correlationId: messageId("corr-2"),
      timeoutMs: 50,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
    }
  });

  test("ignores non-matching messages", async () => {
    const mailbox = createMockMailbox();

    const promise = waitForResponse({
      mailbox,
      correlationId: messageId("corr-3"),
      timeoutMs: 100,
    });

    // Deliver message with wrong correlationId
    mailbox.deliver(mockMessage("wrong-corr"));

    // Deliver message with wrong kind
    mailbox.deliver({
      ...mockMessage("corr-3"),
      kind: "request",
    });

    const result = await promise;
    // Should timeout because no matching message was delivered
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
    }
  });

  test("aborts via AbortSignal", async () => {
    const mailbox = createMockMailbox();
    const controller = new AbortController();

    const promise = waitForResponse({
      mailbox,
      correlationId: messageId("corr-4"),
      timeoutMs: 5000,
      signal: controller.signal,
    });

    controller.abort();

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("aborted");
    }
  });

  test("handles already-aborted signal", async () => {
    const mailbox = createMockMailbox();
    const controller = new AbortController();
    controller.abort();

    const result = await waitForResponse({
      mailbox,
      correlationId: messageId("corr-5"),
      timeoutMs: 5000,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("aborted");
    }
  });

  test("handles immediate response (no race)", async () => {
    const mailbox = createMockMailbox();
    const corrId = messageId("corr-6");

    // Deliver response immediately after subscribing (synchronous delivery)
    const originalOnMessage = mailbox.onMessage;
    let delivered = false;
    mailbox.onMessage = (handler) => {
      const unsub = originalOnMessage(handler);
      if (!delivered) {
        delivered = true;
        mailbox.deliver(mockMessage("corr-6"));
      }
      return unsub;
    };

    const result = await waitForResponse({
      mailbox,
      correlationId: corrId,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
  });
});
