/**
 * Tests for the completion notifier — push notifications on plan completion/failure.
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentMessage,
  AgentMessageInput,
  HarnessStatus,
  KoiError,
  MailboxComponent,
  MessageId,
} from "@koi/core";
import { agentId, harnessId } from "@koi/core";
import { createCompletionNotifier } from "./completion-notifier.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INITIATOR_ID = agentId("copilot-001");
const AGENT_ID = agentId("worker-001");

function createMockMailbox(): MailboxComponent & {
  readonly sentMessages: AgentMessageInput[];
  setNextResult: (
    result: { ok: true; value: AgentMessage } | { ok: false; error: KoiError },
  ) => void;
} {
  const sentMessages: AgentMessageInput[] = [];
  let nextResult:
    | { readonly ok: true; readonly value: AgentMessage }
    | { readonly ok: false; readonly error: KoiError } = {
    ok: true,
    value: {
      id: "msg-1" as MessageId,
      from: AGENT_ID,
      to: INITIATOR_ID,
      kind: "event",
      type: "test",
      payload: {},
      createdAt: new Date().toISOString(),
    },
  };

  return {
    sentMessages,
    setNextResult(result) {
      nextResult = result;
    },
    send: async (message: AgentMessageInput) => {
      sentMessages.push(message);
      return nextResult;
    },
    onMessage: () => () => {},
    list: async () => [],
  };
}

function createTestStatus(overrides?: Partial<HarnessStatus>): HarnessStatus {
  return {
    harnessId: harnessId("test-harness"),
    phase: "completed",
    currentSessionSeq: 3,
    taskBoard: { items: [], results: [] },
    metrics: {
      totalSessions: 3,
      totalTurns: 15,
      totalInputTokens: 5000,
      totalOutputTokens: 2000,
      completedTaskCount: 3,
      pendingTaskCount: 0,
      elapsedMs: 30_000,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCompletionNotifier", () => {
  describe("onCompleted", () => {
    test("sends completion message to initiator via mailbox", async () => {
      const mailbox = createMockMailbox();
      const { onCompleted } = createCompletionNotifier({
        initiatorId: INITIATOR_ID,
        agentId: AGENT_ID,
        mailbox,
      });

      const status = createTestStatus();
      await onCompleted(status);

      expect(mailbox.sentMessages).toHaveLength(1);
      const msg = mailbox.sentMessages[0];
      expect(msg?.from).toBe(AGENT_ID);
      expect(msg?.to).toBe(INITIATOR_ID);
      expect(msg?.kind).toBe("event");
      expect(msg?.type).toBe("autonomous.completed");
    });

    test("includes task counts and summary in payload", async () => {
      const mailbox = createMockMailbox();
      const { onCompleted } = createCompletionNotifier({
        initiatorId: INITIATOR_ID,
        agentId: AGENT_ID,
        mailbox,
      });

      const status = createTestStatus({
        metrics: {
          totalSessions: 2,
          totalTurns: 10,
          totalInputTokens: 3000,
          totalOutputTokens: 1000,
          completedTaskCount: 5,
          pendingTaskCount: 0,
          elapsedMs: 20_000,
        },
      });
      await onCompleted(status);

      const payload = mailbox.sentMessages[0]?.payload;
      expect(payload?.completedTaskCount).toBe(5);
      expect(payload?.totalTaskCount).toBe(5);
      expect(payload?.summary).toContain("5/5");
      expect(payload?.summary).toContain("completed");
    });

    test("uses steer mode for immediate attention", async () => {
      const mailbox = createMockMailbox();
      const { onCompleted } = createCompletionNotifier({
        initiatorId: INITIATOR_ID,
        agentId: AGENT_ID,
        mailbox,
      });

      await onCompleted(createTestStatus());

      const msg = mailbox.sentMessages[0];
      expect(msg?.metadata?.mode).toBe("steer");
    });

    test("does not throw when mailbox send fails", async () => {
      const mailbox = createMockMailbox();
      mailbox.setNextResult({
        ok: false,
        error: { code: "INTERNAL", message: "Mailbox unavailable", retryable: false },
      });

      const { onCompleted } = createCompletionNotifier({
        initiatorId: INITIATOR_ID,
        agentId: AGENT_ID,
        mailbox,
      });

      // Should not throw
      await onCompleted(createTestStatus());
      expect(mailbox.sentMessages).toHaveLength(1);
    });
  });

  describe("onFailed", () => {
    test("sends failure message to initiator via mailbox", async () => {
      const mailbox = createMockMailbox();
      const { onFailed } = createCompletionNotifier({
        initiatorId: INITIATOR_ID,
        agentId: AGENT_ID,
        mailbox,
      });

      const status = createTestStatus({ phase: "failed", failureReason: "Agent timed out" });
      const error: KoiError = { code: "TIMEOUT", message: "Agent timed out", retryable: false };
      await onFailed(status, error);

      expect(mailbox.sentMessages).toHaveLength(1);
      const msg = mailbox.sentMessages[0];
      expect(msg?.from).toBe(AGENT_ID);
      expect(msg?.to).toBe(INITIATOR_ID);
      expect(msg?.kind).toBe("event");
      expect(msg?.type).toBe("autonomous.failed");
    });

    test("includes error details and task counts in payload", async () => {
      const mailbox = createMockMailbox();
      const { onFailed } = createCompletionNotifier({
        initiatorId: INITIATOR_ID,
        agentId: AGENT_ID,
        mailbox,
      });

      const status = createTestStatus({
        phase: "failed",
        metrics: {
          totalSessions: 2,
          totalTurns: 10,
          totalInputTokens: 3000,
          totalOutputTokens: 1000,
          completedTaskCount: 2,
          pendingTaskCount: 1,
          elapsedMs: 15_000,
        },
      });
      const error: KoiError = { code: "TIMEOUT", message: "Agent timed out", retryable: false };
      await onFailed(status, error);

      const payload = mailbox.sentMessages[0]?.payload;
      expect(payload?.errorCode).toBe("TIMEOUT");
      expect(payload?.errorMessage).toBe("Agent timed out");
      expect(payload?.completedTaskCount).toBe(2);
      expect(payload?.totalTaskCount).toBe(3);
      expect(payload?.summary).toContain("failed");
      expect(payload?.summary).toContain("2/3");
    });

    test("uses steer mode for immediate attention", async () => {
      const mailbox = createMockMailbox();
      const { onFailed } = createCompletionNotifier({
        initiatorId: INITIATOR_ID,
        agentId: AGENT_ID,
        mailbox,
      });

      const error: KoiError = { code: "TIMEOUT", message: "Timed out", retryable: false };
      await onFailed(createTestStatus({ phase: "failed" }), error);

      const msg = mailbox.sentMessages[0];
      expect(msg?.metadata?.mode).toBe("steer");
    });

    test("does not throw when mailbox send fails", async () => {
      const mailbox = createMockMailbox();
      mailbox.setNextResult({
        ok: false,
        error: { code: "INTERNAL", message: "Mailbox unavailable", retryable: false },
      });

      const { onFailed } = createCompletionNotifier({
        initiatorId: INITIATOR_ID,
        agentId: AGENT_ID,
        mailbox,
      });

      const error: KoiError = { code: "TIMEOUT", message: "Timed out", retryable: false };
      // Should not throw
      await onFailed(createTestStatus({ phase: "failed" }), error);
      expect(mailbox.sentMessages).toHaveLength(1);
    });
  });
});
