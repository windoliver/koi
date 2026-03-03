import { describe, expect, test } from "bun:test";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { defaultRepairStrategy } from "./repair.js";
import { computeTransportDelay, createRetryLoop, ValidationFailure } from "./retry.js";

const baseRequest: ModelRequest = {
  messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
};

const goodResponse: ModelResponse = { content: "ok", model: "m" };

describe("computeTransportDelay", () => {
  test("returns exponential + jitter", () => {
    const result = computeTransportDelay(0, 1000, 30_000);
    // baseDelay * 2^0 = 1000, + jitter in [0, 1000)
    expect(result).toBeGreaterThanOrEqual(1000);
    expect(result).toBeLessThan(2000);
  });

  test("caps at maxDelayMs", () => {
    const result = computeTransportDelay(100, 1000, 5000);
    // min(5000, 1000 * 2^100) = 5000, + jitter in [0, 1000)
    expect(result).toBeGreaterThanOrEqual(5000);
    expect(result).toBeLessThan(6000);
  });

  test("attempt 2 doubles base", () => {
    // attempt=2: min(30000, 1000 * 2^2) = 4000, + jitter [0,1000)
    const result = computeTransportDelay(2, 1000, 30_000);
    expect(result).toBeGreaterThanOrEqual(4000);
    expect(result).toBeLessThan(5000);
  });
});

describe("createRetryLoop", () => {
  test("returns result on first success", async () => {
    const loop = createRetryLoop({});
    const result = await loop.execute(async () => goodResponse, baseRequest, defaultRepairStrategy);
    expect(result).toBe(goodResponse);
  });

  test("retries on validation failure and succeeds", async () => {
    const loop = createRetryLoop({ validation: { maxAttempts: 3 } });
    // let: counter mutated across retries
    let attempt = 0;
    const result = await loop.execute(
      async () => {
        attempt++;
        if (attempt < 2) {
          throw new ValidationFailure([{ validator: "v1", message: "bad" }], {
            content: "bad",
            model: "m",
          });
        }
        return goodResponse;
      },
      baseRequest,
      defaultRepairStrategy,
    );
    expect(result).toBe(goodResponse);
    expect(attempt).toBe(2);
  });

  test("throws on validation exhaustion", async () => {
    const loop = createRetryLoop({ validation: { maxAttempts: 2 } });
    const errors = [{ validator: "v1", message: "always bad" }];
    try {
      await loop.execute(
        async () => {
          throw new ValidationFailure(errors, { content: "bad", model: "m" });
        },
        baseRequest,
        defaultRepairStrategy,
      );
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("VALIDATION");
        expect(e.message).toContain("2 attempts");
      }
    }
  });

  test("early termination on non-retryable error", async () => {
    const loop = createRetryLoop({ validation: { maxAttempts: 5 } });
    // let: counter to verify only one attempt
    let attempts = 0;
    try {
      await loop.execute(
        async () => {
          attempts++;
          throw new ValidationFailure([{ validator: "v1", message: "fatal", retryable: false }], {
            content: "bad",
            model: "m",
          });
        },
        baseRequest,
        defaultRepairStrategy,
      );
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.message).toContain("non-retryable");
      }
    }
    expect(attempts).toBe(1);
  });

  test("calls onRetry with attempt number and errors", async () => {
    const loop = createRetryLoop({ validation: { maxAttempts: 3 } });
    const retryCalls: Array<{ attempt: number; errorCount: number }> = [];
    // let: counter for retry tracking
    let attempt = 0;
    await loop.execute(
      async () => {
        attempt++;
        if (attempt < 3) {
          throw new ValidationFailure([{ validator: "v1", message: `fail ${attempt}` }], {
            content: "bad",
            model: "m",
          });
        }
        return goodResponse;
      },
      baseRequest,
      defaultRepairStrategy,
      (a, errors) => retryCalls.push({ attempt: a, errorCount: errors.length }),
    );
    expect(retryCalls).toHaveLength(2);
    expect(retryCalls[0]?.attempt).toBe(1);
    expect(retryCalls[1]?.attempt).toBe(2);
  });

  test("re-throws transport errors after exhaustion", async () => {
    const loop = createRetryLoop({
      transport: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });
    const original = new Error("network down");
    try {
      await loop.execute(
        async () => {
          throw original;
        },
        baseRequest,
        defaultRepairStrategy,
      );
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBe(original);
    }
  });

  test("uses repair strategy for retry request", async () => {
    const loop = createRetryLoop({ validation: { maxAttempts: 2 } });
    const requests: ModelRequest[] = [];
    const customRepair = {
      buildRetryRequest: (
        orig: ModelRequest,
        _resp: ModelResponse,
        _errors: readonly unknown[],
        attempt: number,
      ): ModelRequest => ({
        ...orig,
        messages: [
          ...orig.messages,
          {
            senderId: "repair",
            timestamp: Date.now(),
            content: [{ kind: "text" as const, text: `retry ${attempt}` }],
          },
        ],
      }),
    };
    // let: counter for tracking
    let attempt = 0;
    await loop.execute(
      async (req) => {
        attempt++;
        requests.push(req);
        if (attempt < 2) {
          throw new ValidationFailure([{ validator: "v1", message: "bad" }], {
            content: "bad",
            model: "m",
          });
        }
        return goodResponse;
      },
      baseRequest,
      customRepair,
    );
    expect(requests).toHaveLength(2);
    // Second request should have repair message appended
    expect(requests[1]?.messages).toHaveLength(2);
  });
});
