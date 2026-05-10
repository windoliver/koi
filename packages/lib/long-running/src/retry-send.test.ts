import { describe, expect, it } from "bun:test";
import { sendWithRetry } from "./retry-send.js";

describe("sendWithRetry", () => {
  it("retries transient failures until send succeeds", async () => {
    let attempts = 0;

    const result = await sendWithRetry(
      async (message: string) => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(`temporary failure for ${message}`);
        }
      },
      "job completed",
      {
        maxRetries: 3,
        isTransientError: () => true,
      },
    );

    expect(result).toEqual({
      ok: true,
      attempts: 3,
    });
  });

  it("returns the last error after exhausting transient retries", async () => {
    const error = new Error("socket timeout");

    const result = await sendWithRetry(
      async () => {
        throw error;
      },
      "job failed",
      {
        maxRetries: 2,
        isTransientError: () => true,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(3);
    expect(result.exhausted).toBe(true);
    expect(result.transient).toBe(true);
    expect(result.error).toBe(error);
  });

  it("does not retry non-transient failures", async () => {
    const error = new Error("bad request");
    let attempts = 0;

    const result = await sendWithRetry(
      async () => {
        attempts += 1;
        throw error;
      },
      "job failed",
      {
        maxRetries: 5,
        isTransientError: () => false,
      },
    );

    expect(attempts).toBe(1);
    expect(result).toEqual({
      ok: false,
      attempts: 1,
      exhausted: false,
      transient: false,
      error,
    });
  });

  it("waits between retries when delayMs is configured", async () => {
    const delays: number[] = [];

    const result = await sendWithRetry(
      async () => {
        throw new Error("retry me");
      },
      "job failed",
      {
        maxRetries: 2,
        delayMs: 25,
        isTransientError: () => true,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(delays).toEqual([25, 25]);
  });

  it("treats thrown strings as errors when retries are exhausted", async () => {
    const result = await sendWithRetry(
      async () => {
        throw "string failure";
      },
      "job failed",
      {
        maxRetries: 0,
        isTransientError: () => true,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(1);
    expect(result.exhausted).toBe(true);
    expect(result.transient).toBe(true);
    expect(result.error.message).toBe("string failure");
  });

  it("uses the default delay path for transient retries", async () => {
    let attempts = 0;

    const result = await sendWithRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary outage");
        }
      },
      "job completed",
      {
        maxRetries: 1,
        delayMs: 1,
        isTransientError: () => true,
      },
    );

    expect(result).toEqual({
      ok: true,
      attempts: 2,
    });
  });

  it("times out a hung send attempt instead of blocking forever", async () => {
    let attempts = 0;
    const result = await sendWithRetry(
      async () => {
        attempts += 1;
        // Simulate a stuck transport — never settles.
        await new Promise(() => undefined);
      },
      "job completed",
      {
        maxRetries: 1,
        attemptTimeoutMs: 5,
        delayMs: 0,
        isTransientError: () => true,
      },
    );

    expect(attempts).toBe(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exhausted).toBe(true);
      expect(result.error.message).toContain("timed out");
    }
  });

  it("aborts an in-flight attempt via the signal when the per-attempt timeout fires", async () => {
    const sawAbort: boolean[] = [];
    let attempts = 0;
    const result = await sendWithRetry(
      async (_msg, signal) => {
        attempts += 1;
        // Abort-aware transport: resolve early when the signal aborts so the
        // retry loop can proceed without leaking the in-flight promise.
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            sawAbort.push(true);
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => {
            sawAbort.push(true);
            resolve();
          });
        });
        // After abort, throw so the loop treats this as a transient failure.
        throw new Error("aborted");
      },
      "msg",
      {
        maxRetries: 1,
        attemptTimeoutMs: 3,
        delayMs: 0,
        isTransientError: () => true,
      },
    );

    expect(attempts).toBe(2);
    expect(sawAbort.length).toBe(2);
    expect(result.ok).toBe(false);
  });

  it("does not retry by default — caller must opt in via isTransientError", async () => {
    let attempts = 0;

    const result = await sendWithRetry(
      async () => {
        attempts += 1;
        throw new Error("ambiguous transport failure");
      },
      "job completed",
      { maxRetries: 5, delayMs: 0 },
    );

    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.transient).toBe(false);
      expect(result.exhausted).toBe(false);
    }
  });
});
