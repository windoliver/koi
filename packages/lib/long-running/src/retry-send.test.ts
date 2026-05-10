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
      },
    );

    expect(result).toEqual({
      ok: true,
      attempts: 2,
    });
  });
});
