import { describe, expect, it } from "bun:test";
import type { HarnessStatus, KoiError } from "@koi/core";
import { createCompletionNotifier } from "./completion-notifier.js";
import { EMPTY_TASK_BOARD, ZERO_METRICS } from "./snapshot-builder.js";

const makeStatus = (phase: HarnessStatus["phase"]): HarnessStatus =>
  ({
    harnessId: "h-123",
    phase,
    currentSessionSeq: 4,
    taskBoard: EMPTY_TASK_BOARD,
    metrics: ZERO_METRICS,
  }) as HarnessStatus;

describe("createCompletionNotifier", () => {
  it("formats completed notifications and sends them via the retry helper", async () => {
    const sent: string[] = [];
    const notifier = createCompletionNotifier({
      send: async (message) => {
        sent.push(message);
      },
    });

    const result = await notifier.notifyCompleted(makeStatus("completed"));

    expect(result).toEqual({
      ok: true,
      attempts: 1,
    });
    expect(sent).toEqual(["Long-running session h-123 completed."]);
  });

  it("formats failed notifications with the error message", async () => {
    const sent: string[] = [];
    const notifier = createCompletionNotifier({
      send: async (message) => {
        sent.push(message);
      },
    });

    const result = await notifier.notifyFailed(makeStatus("failed"), {
      code: "EXTERNAL",
      message: "upstream timeout",
      retryable: true,
    } satisfies KoiError);

    expect(result).toEqual({
      ok: true,
      attempts: 1,
    });
    expect(sent).toEqual(["Long-running session h-123 failed: upstream timeout"]);
  });

  it("retries notification sends using the configured retry policy", async () => {
    let attempts = 0;
    const notifier = createCompletionNotifier({
      send: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("temporary webhook outage");
        }
      },
      retry: {
        maxRetries: 2,
        isTransientError: () => true,
      },
    });

    const result = await notifier.notifyCompleted(makeStatus("completed"));

    expect(result).toEqual({
      ok: true,
      attempts: 3,
    });
  });

  it("throws when delivery exhausts and no onSendFailure is configured", async () => {
    const notifier = createCompletionNotifier({
      send: async () => {
        throw new Error("permanent webhook offline");
      },
    });

    await expect(notifier.notifyCompleted(makeStatus("completed"))).rejects.toThrow(
      "permanent webhook offline",
    );
  });

  it("invokes onSendFailure instead of throwing when configured", async () => {
    let captured: { ok: false } | undefined;
    const notifier = createCompletionNotifier({
      send: async () => {
        throw new Error("permanent webhook offline");
      },
      onSendFailure: (failure) => {
        captured = failure;
      },
    });

    const result = await notifier.notifyCompleted(makeStatus("completed"));
    expect(result.ok).toBe(false);
    expect(captured?.ok).toBe(false);
  });

  it("forwards an AbortSignal to the transport so abort-aware sends can avoid duplicates", async () => {
    const seen: AbortSignal[] = [];
    let calls = 0;
    const notifier = createCompletionNotifier({
      send: async (_message, signal) => {
        if (signal !== undefined) seen.push(signal);
        calls += 1;
        if (calls === 1) {
          // Stuck transport — only resolves if the signal aborts.
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
          });
        }
      },
      retry: {
        maxRetries: 1,
        delayMs: 0,
        attemptTimeoutMs: 5,
        isTransientError: () => true,
      },
    });

    const result = await notifier.notifyCompleted(makeStatus("completed"));
    expect(result.ok).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it("allows custom message formatters", async () => {
    const sent: string[] = [];
    const notifier = createCompletionNotifier({
      send: async (message) => {
        sent.push(message);
      },
      formatCompleted: (status) => `done:${status.harnessId}`,
      formatFailed: (status, error) => `oops:${status.harnessId}:${error.code}`,
    });

    await notifier.notifyCompleted(makeStatus("completed"));
    await notifier.notifyFailed(makeStatus("failed"), {
      code: "INTERNAL",
      message: "boom",
      retryable: false,
    } satisfies KoiError);

    expect(sent).toEqual(["done:h-123", "oops:h-123:INTERNAL"]);
  });
});
