/**
 * Tests for retry-send — exponential backoff wrapper for MailboxComponent.send().
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentMessage,
  AgentMessageInput,
  KoiError,
  MailboxComponent,
  MessageId,
  Result,
} from "@koi/core";
import { agentId } from "@koi/core";
import { computeRetryDelay, sendWithRetry } from "./retry-send.js";
import type { AutonomousLogger } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SENDER_ID = agentId("sender-001");
const RECIPIENT_ID = agentId("recipient-001");

const OK_MESSAGE: AgentMessage = {
  id: "msg-ok" as MessageId,
  from: SENDER_ID,
  to: RECIPIENT_ID,
  kind: "event",
  type: "test",
  payload: {},
  createdAt: new Date().toISOString(),
};

const OK_RESULT: Result<AgentMessage, KoiError> = { ok: true, value: OK_MESSAGE };

const RETRYABLE_ERROR: KoiError = {
  code: "EXTERNAL",
  message: "Service temporarily unavailable",
  retryable: true,
};

const NON_RETRYABLE_ERROR: KoiError = {
  code: "VALIDATION",
  message: "Bad request payload",
  retryable: false,
};

const TEST_MESSAGE: AgentMessageInput = {
  from: SENDER_ID,
  to: RECIPIENT_ID,
  kind: "event",
  type: "test.ping",
  payload: { data: "hello" },
};

function createMockMailbox(
  results: ReadonlyArray<Result<AgentMessage, KoiError>>,
): MailboxComponent & { readonly calls: AgentMessageInput[] } {
  const calls: AgentMessageInput[] = [];
  let callIndex = 0;

  return {
    calls,
    send: async (message: AgentMessageInput) => {
      calls.push(message);
      const result = results[callIndex] ?? results[results.length - 1];
      callIndex++;
      return result as Result<AgentMessage, KoiError>;
    },
    onMessage: () => () => {},
    list: async () => [],
  };
}

function createMockLogger(): AutonomousLogger & {
  readonly debugCalls: readonly string[];
  readonly warnCalls: readonly string[];
} {
  const debugCalls: string[] = [];
  const warnCalls: string[] = [];
  return {
    debugCalls,
    warnCalls,
    debug: (msg: string) => {
      debugCalls.push(msg);
    },
    warn: (msg: string) => {
      warnCalls.push(msg);
    },
    error: (_msg: string) => {},
  };
}

// ---------------------------------------------------------------------------
// computeRetryDelay
// ---------------------------------------------------------------------------

describe("computeRetryDelay", () => {
  test("returns base delay for attempt 0", () => {
    expect(computeRetryDelay(0, 100, 10_000)).toBe(100);
  });

  test("doubles delay for each subsequent attempt", () => {
    expect(computeRetryDelay(0, 100, 10_000)).toBe(100);
    expect(computeRetryDelay(1, 100, 10_000)).toBe(200);
    expect(computeRetryDelay(2, 100, 10_000)).toBe(400);
    expect(computeRetryDelay(3, 100, 10_000)).toBe(800);
  });

  test("caps delay at maxMs", () => {
    // 100 * 2^10 = 102400, capped at 500
    expect(computeRetryDelay(10, 100, 500)).toBe(500);
  });

  test("returns maxMs when base exceeds max", () => {
    expect(computeRetryDelay(0, 2000, 500)).toBe(500);
  });

  test("returns exact maxMs at boundary", () => {
    // 100 * 2^3 = 800, maxMs = 800 => exactly at cap
    expect(computeRetryDelay(3, 100, 800)).toBe(800);
  });
});

// ---------------------------------------------------------------------------
// sendWithRetry
// ---------------------------------------------------------------------------

describe("sendWithRetry", () => {
  test("succeeds on first try without retrying", async () => {
    const mailbox = createMockMailbox([OK_RESULT]);

    const result = await sendWithRetry(mailbox, TEST_MESSAGE, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(OK_MESSAGE.id);
    }
    expect(mailbox.calls).toHaveLength(1);
  });

  test("retries on retryable error then succeeds", async () => {
    const mailbox = createMockMailbox([
      { ok: false, error: RETRYABLE_ERROR },
      { ok: false, error: RETRYABLE_ERROR },
      OK_RESULT,
    ]);

    const result = await sendWithRetry(mailbox, TEST_MESSAGE, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    expect(result.ok).toBe(true);
    // Initial attempt + 2 retries = 3 total calls
    expect(mailbox.calls).toHaveLength(3);
  });

  test("exhausts all retries and returns last error", async () => {
    const mailbox = createMockMailbox([{ ok: false, error: RETRYABLE_ERROR }]);

    const result = await sendWithRetry(mailbox, TEST_MESSAGE, {
      maxRetries: 2,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
    }
    // Initial attempt + 2 retries = 3 total calls
    expect(mailbox.calls).toHaveLength(3);
  });

  test("does not retry non-retryable errors", async () => {
    const mailbox = createMockMailbox([{ ok: false, error: NON_RETRYABLE_ERROR }]);

    const result = await sendWithRetry(mailbox, TEST_MESSAGE, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.retryable).toBe(false);
    }
    // Only the initial attempt, no retries
    expect(mailbox.calls).toHaveLength(1);
  });

  test("performs maxRetries + 1 total attempts", async () => {
    const maxRetries = 4;
    const mailbox = createMockMailbox([{ ok: false, error: RETRYABLE_ERROR }]);

    await sendWithRetry(mailbox, TEST_MESSAGE, {
      maxRetries,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    expect(mailbox.calls).toHaveLength(maxRetries + 1);
  });

  test("calls logger.debug on each retry", async () => {
    const logger = createMockLogger();
    const mailbox = createMockMailbox([
      { ok: false, error: RETRYABLE_ERROR },
      { ok: false, error: RETRYABLE_ERROR },
      { ok: false, error: RETRYABLE_ERROR },
      OK_RESULT,
    ]);

    await sendWithRetry(mailbox, TEST_MESSAGE, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
      logger,
    });

    // 3 failures before success = 3 retry debug logs (attempts 0, 1, 2 trigger retries)
    expect(logger.debugCalls).toHaveLength(3);
    expect(logger.debugCalls[0]).toContain("retrying");
    expect(logger.debugCalls[0]).toContain("attempt 1/3");
    expect(logger.debugCalls[1]).toContain("attempt 2/3");
    expect(logger.debugCalls[2]).toContain("attempt 3/3");
  });

  test("calls logger.warn on final failure after exhausting retries", async () => {
    const logger = createMockLogger();
    const mailbox = createMockMailbox([{ ok: false, error: RETRYABLE_ERROR }]);

    await sendWithRetry(mailbox, TEST_MESSAGE, {
      maxRetries: 2,
      baseDelayMs: 1,
      maxDelayMs: 10,
      logger,
    });

    expect(logger.warnCalls).toHaveLength(1);
    expect(logger.warnCalls[0]).toContain("failed after 2 retries");
  });

  test("calls logger.warn on non-retryable error", async () => {
    const logger = createMockLogger();
    const mailbox = createMockMailbox([{ ok: false, error: NON_RETRYABLE_ERROR }]);

    await sendWithRetry(mailbox, TEST_MESSAGE, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
      logger,
    });

    expect(logger.warnCalls).toHaveLength(1);
    expect(logger.warnCalls[0]).toContain("non-retryable");
    expect(logger.warnCalls[0]).toContain(NON_RETRYABLE_ERROR.code);
  });

  test("works with default config (no config passed)", async () => {
    // When no config is passed, defaults apply (maxRetries=3, baseDelayMs=1000, maxDelayMs=10000).
    // We test that it succeeds on first try without error when no config is given.
    const mailbox = createMockMailbox([OK_RESULT]);

    const result = await sendWithRetry(mailbox, TEST_MESSAGE);

    expect(result.ok).toBe(true);
    expect(mailbox.calls).toHaveLength(1);
  });

  test("passes the message to mailbox.send on every attempt", async () => {
    const mailbox = createMockMailbox([{ ok: false, error: RETRYABLE_ERROR }, OK_RESULT]);

    await sendWithRetry(mailbox, TEST_MESSAGE, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    // Every call should receive the same message
    for (const call of mailbox.calls) {
      expect(call.from).toBe(TEST_MESSAGE.from);
      expect(call.to).toBe(TEST_MESSAGE.to);
      expect(call.type).toBe(TEST_MESSAGE.type);
    }
  });

  test("does not log debug when logger has no debug method", async () => {
    const logger: AutonomousLogger = {
      warn: mock(() => {}),
      error: mock(() => {}),
      // debug is undefined
    };
    const mailbox = createMockMailbox([{ ok: false, error: RETRYABLE_ERROR }, OK_RESULT]);

    // Should not throw when logger.debug is undefined
    const result = await sendWithRetry(mailbox, TEST_MESSAGE, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
      logger,
    });

    expect(result.ok).toBe(true);
  });

  test("returns immediately with zero maxRetries on retryable error", async () => {
    const logger = createMockLogger();
    const mailbox = createMockMailbox([{ ok: false, error: RETRYABLE_ERROR }]);

    const result = await sendWithRetry(mailbox, TEST_MESSAGE, {
      maxRetries: 0,
      baseDelayMs: 1,
      maxDelayMs: 10,
      logger,
    });

    expect(result.ok).toBe(false);
    expect(mailbox.calls).toHaveLength(1);
    // Should still log the final warn
    expect(logger.warnCalls).toHaveLength(1);
    expect(logger.warnCalls[0]).toContain("failed after 0 retries");
  });
});
