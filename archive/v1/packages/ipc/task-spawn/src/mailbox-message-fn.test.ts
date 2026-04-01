import { describe, expect, test } from "bun:test";
import type { AgentMessage, AgentMessageInput, MailboxComponent } from "@koi/core";
import { agentId, messageId } from "@koi/core";
import { createMailboxMessageFn } from "./mailbox-message-fn.js";

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
          from: agentId("parent"),
          to: agentId("child"),
          kind: "request" as const,
          createdAt: new Date().toISOString(),
          type: "task",
          payload: { description: "do work" },
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

function mockResponse(correlationId: string, output: string): AgentMessage {
  return {
    id: messageId("resp-1"),
    from: agentId("child"),
    to: agentId("parent"),
    kind: "response",
    correlationId: messageId(correlationId),
    createdAt: new Date().toISOString(),
    type: "task",
    payload: { output },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMailboxMessageFn", () => {
  test("happy path: send → response → returns ok with output", async () => {
    const mailbox = createMockMailbox();
    const messageFn = createMailboxMessageFn({
      mailbox,
      senderId: agentId("parent"),
      timeoutMs: 5000,
    });

    const promise = messageFn({
      agentId: agentId("child"),
      description: "analyze logs",
      signal: new AbortController().signal,
    });

    // Yield to let send complete and subscription set up
    await new Promise((r) => setTimeout(r, 10));
    mailbox.deliver(mockResponse("sent-msg-1", "Logs analyzed: 3 errors found"));

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe("Logs analyzed: 3 errors found");
    }
  });

  test("timeout: no response → returns ok: false with timeout error", async () => {
    const mailbox = createMockMailbox();
    const messageFn = createMailboxMessageFn({
      mailbox,
      senderId: agentId("parent"),
      timeoutMs: 50,
    });

    const result = await messageFn({
      agentId: agentId("child"),
      description: "slow task",
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("timeout");
    }
  });

  test("abort: signal aborted → returns ok: false with aborted error", async () => {
    const mailbox = createMockMailbox();
    const messageFn = createMailboxMessageFn({
      mailbox,
      senderId: agentId("parent"),
      timeoutMs: 5000,
    });

    const controller = new AbortController();

    const promise = messageFn({
      agentId: agentId("child"),
      description: "abortable task",
      signal: controller.signal,
    });

    controller.abort();

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("aborted");
    }
  });

  test("send failure: mailbox.send() returns ok: false → returns error", async () => {
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
    const messageFn = createMailboxMessageFn({
      mailbox,
      senderId: agentId("parent"),
      timeoutMs: 5000,
    });

    const result = await messageFn({
      agentId: agentId("child"),
      description: "unreachable task",
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("send_failed");
    }
  });

  test("extracts output from payload.output field", async () => {
    const mailbox = createMockMailbox();
    const messageFn = createMailboxMessageFn({
      mailbox,
      senderId: agentId("parent"),
      timeoutMs: 5000,
    });

    const promise = messageFn({
      agentId: agentId("child"),
      description: "get result",
      signal: new AbortController().signal,
    });

    await new Promise((r) => setTimeout(r, 10));
    mailbox.deliver(mockResponse("sent-msg-1", "specific output value"));

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe("specific output value");
    }
  });
});
