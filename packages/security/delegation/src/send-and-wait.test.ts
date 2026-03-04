import { describe, expect, test } from "bun:test";
import type { AgentMessage, AgentMessageInput, MailboxComponent } from "@koi/core";
import { agentId, messageId } from "@koi/core";
import { sendAndWait } from "./send-and-wait.js";

// ---------------------------------------------------------------------------
// Mock mailbox factory
// ---------------------------------------------------------------------------

function createMockMailbox(opts?: {
  readonly sendResult?: Awaited<ReturnType<MailboxComponent["send"]>>;
  readonly sendThrows?: boolean;
}): MailboxComponent & { readonly deliver: (message: AgentMessage) => void } {
  const handlers: Array<(message: AgentMessage) => void | Promise<void>> = [];
  const sentId = messageId("sent-msg-1");

  return {
    send: async (_msg: AgentMessageInput) => {
      if (opts?.sendThrows) throw new Error("send exploded");
      if (opts?.sendResult !== undefined) return opts.sendResult;
      return {
        ok: true as const,
        value: {
          id: sentId,
          from: agentId("child"),
          to: agentId("parent"),
          kind: "request" as const,
          createdAt: new Date().toISOString(),
          type: "test",
          payload: {},
        },
      };
    },
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

function mockResponse(correlationId: string): AgentMessage {
  return {
    id: messageId("resp-1"),
    from: agentId("parent"),
    to: agentId("child"),
    kind: "response",
    correlationId: messageId(correlationId),
    createdAt: new Date().toISOString(),
    type: "test",
    payload: { output: "done" },
  };
}

const baseMessage: AgentMessageInput = {
  from: agentId("child"),
  to: agentId("parent"),
  kind: "request",
  type: "test",
  payload: { description: "do something" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sendAndWait", () => {
  test("happy path: send succeeds → response arrives → returns ok", async () => {
    const mailbox = createMockMailbox();

    const promise = sendAndWait({
      mailbox,
      message: baseMessage,
      timeoutMs: 5000,
    });

    // Yield to let send() complete and waitForResponse subscribe
    await new Promise((r) => setTimeout(r, 10));

    // Deliver matching response (correlationId = sent message's id)
    mailbox.deliver(mockResponse("sent-msg-1"));

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.correlationId).toBe(messageId("sent-msg-1"));
    }
  });

  test("send failure: mailbox.send() returns ok: false → returns send_failed", async () => {
    const mailbox = createMockMailbox({
      sendResult: {
        ok: false,
        error: {
          code: "EXTERNAL" as const,
          message: "connection refused",
          retryable: false,
        },
      },
    });

    const result = await sendAndWait({
      mailbox,
      message: baseMessage,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("send_failed");
    }
  });

  test("send throws: mailbox.send() throws → returns send_failed", async () => {
    const mailbox = createMockMailbox({ sendThrows: true });

    const result = await sendAndWait({
      mailbox,
      message: baseMessage,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("send_failed");
    }
  });

  test("timeout: send succeeds but no response → returns timeout", async () => {
    const mailbox = createMockMailbox();

    const result = await sendAndWait({
      mailbox,
      message: baseMessage,
      timeoutMs: 50,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
    }
  });

  test("abort: signal aborted during wait → returns aborted", async () => {
    const mailbox = createMockMailbox();
    const controller = new AbortController();

    const promise = sendAndWait({
      mailbox,
      message: baseMessage,
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
});
