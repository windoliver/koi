import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { KoiError } from "@koi/core";
import * as errors from "@koi/errors";
import { createRateLimiter } from "./rate-limit.js";

const koiError = (overrides: Partial<KoiError> & Pick<KoiError, "code">): KoiError => ({
  code: overrides.code,
  message: overrides.message ?? "test",
  retryable: overrides.retryable ?? false,
  ...(overrides.retryAfterMs === undefined ? {} : { retryAfterMs: overrides.retryAfterMs }),
  ...(overrides.context === undefined ? {} : { context: overrides.context }),
});

describe("createRateLimiter", () => {
  let sleepSpy: ReturnType<typeof spyOn<typeof errors, "sleep">>;

  beforeEach(() => {
    sleepSpy = spyOn(errors, "sleep").mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    sleepSpy.mockRestore();
  });

  it("runs a single send", async () => {
    const limiter = createRateLimiter();
    const fn = mock(() => Promise.resolve());
    await limiter.enqueue(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent sends in FIFO order", async () => {
    const limiter = createRateLimiter();
    const order: number[] = [];
    const make = (n: number) => async () => {
      order.push(n);
    };
    await Promise.all([
      limiter.enqueue(make(1)),
      limiter.enqueue(make(2)),
      limiter.enqueue(make(3)),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("propagates final-attempt failure to caller", async () => {
    const limiter = createRateLimiter({
      retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
    });
    const err = new Error("boom");
    await expect(limiter.enqueue(() => Promise.reject(err))).rejects.toBe(err);
  });

  it("retries on rate-limit and uses extracted retry-after delay", async () => {
    const extract = mock((e: unknown) =>
      e instanceof Error && e.message === "429" ? 250 : undefined,
    );
    const limiter = createRateLimiter({
      retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 2, jitter: false },
      extractRetryAfterMs: extract,
      isRetryable: (e) => e instanceof Error && e.message === "429",
    });
    let attempts = 0;
    await limiter.enqueue(async () => {
      attempts++;
      if (attempts < 2) throw new Error("429");
    });
    expect(attempts).toBe(2);
    expect(sleepSpy).toHaveBeenCalledWith(250);
  });

  it("falls back to computeBackoff when isRetryable returns true", async () => {
    const limiter = createRateLimiter({
      retry: {
        ...errors.DEFAULT_RETRY_CONFIG,
        maxRetries: 1,
        initialDelayMs: 50,
        jitter: false,
      },
      isRetryable: () => true,
    });
    let attempts = 0;
    await limiter.enqueue(async () => {
      attempts++;
      if (attempts < 2) throw new Error("transient");
    });
    expect(attempts).toBe(2);
    expect(sleepSpy).toHaveBeenCalledWith(50);
  });

  it("does not retry non-rate-limit errors by default", async () => {
    const limiter = createRateLimiter({
      retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 5, initialDelayMs: 10, jitter: false },
    });
    let attempts = 0;
    const fn = async (): Promise<void> => {
      attempts++;
      throw new Error("permission denied");
    };
    await expect(limiter.enqueue(fn)).rejects.toThrow("permission denied");
    expect(attempts).toBe(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it("does not sleep on the terminal attempt of an exhausted retry-after", async () => {
    const limiter = createRateLimiter({
      retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 1, initialDelayMs: 10, jitter: false },
    });
    let attempts = 0;
    const fn = async (): Promise<void> => {
      attempts++;
      throw koiError({ code: "RATE_LIMIT", retryAfterMs: 250 });
    };
    await expect(limiter.enqueue(fn)).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(attempts).toBe(2);
    // One sleep between attempts 0 and 1; no sleep after the terminal attempt
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenCalledWith(250);
  });

  it("continues processing queue after a failed item", async () => {
    const limiter = createRateLimiter();
    const completed: string[] = [];
    const failing = limiter.enqueue(() => Promise.reject(new Error("x")));
    const succeeding = limiter.enqueue(async () => {
      completed.push("ok");
    });
    await expect(failing).rejects.toThrow("x");
    await succeeding;
    expect(completed).toEqual(["ok"]);
  });

  describe("default policy honors KoiError metadata", () => {
    it("retries a KoiError with retryAfterMs", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 2, initialDelayMs: 10, jitter: false },
      });
      let attempts = 0;
      await limiter.enqueue(async () => {
        attempts++;
        if (attempts < 2) throw koiError({ code: "RATE_LIMIT", retryAfterMs: 750 });
      });
      expect(attempts).toBe(2);
      expect(sleepSpy).toHaveBeenCalledWith(750);
    });

    it("retries a KoiError whose code is in the retryable set", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 1, initialDelayMs: 25, jitter: false },
      });
      let attempts = 0;
      await limiter.enqueue(async () => {
        attempts++;
        if (attempts < 2) throw koiError({ code: "TIMEOUT" });
      });
      expect(attempts).toBe(2);
      expect(sleepSpy).toHaveBeenCalledWith(25);
    });

    it("rejects a KoiError whose code is not retryable without re-issuing", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 5 },
      });
      let attempts = 0;
      await expect(
        limiter.enqueue(async () => {
          attempts++;
          throw koiError({ code: "PERMISSION" });
        }),
      ).rejects.toMatchObject({ code: "PERMISSION" });
      expect(attempts).toBe(1);
      expect(sleepSpy).not.toHaveBeenCalled();
    });

    it("rejects a non-KoiError thrown without re-issuing", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 3 },
      });
      let attempts = 0;
      await expect(
        limiter.enqueue(async () => {
          attempts++;
          throw new Error("plain transport blip");
        }),
      ).rejects.toThrow("plain transport blip");
      expect(attempts).toBe(1);
    });
  });

  describe("caller-supplied policy hooks", () => {
    it("retries when only extractRetryAfterMs is provided (no isRetryable)", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 2, jitter: false },
        extractRetryAfterMs: (e) =>
          e instanceof Error && e.message === "throttled" ? 75 : undefined,
      });
      let attempts = 0;
      await limiter.enqueue(async () => {
        attempts++;
        if (attempts < 2) throw new Error("throttled");
      });
      expect(attempts).toBe(2);
      expect(sleepSpy).toHaveBeenCalledWith(75);
    });

    it("retries when only isRetryable is provided (no extractor)", async () => {
      const limiter = createRateLimiter({
        retry: {
          ...errors.DEFAULT_RETRY_CONFIG,
          maxRetries: 1,
          initialDelayMs: 30,
          jitter: false,
        },
        isRetryable: () => true,
      });
      let attempts = 0;
      await limiter.enqueue(async () => {
        attempts++;
        if (attempts < 2) throw new Error("transient");
      });
      expect(attempts).toBe(2);
      expect(sleepSpy).toHaveBeenCalledWith(30);
    });
  });

  describe("retryAfterMs alone does not force retry for non-transport codes", () => {
    it("AUTH_REQUIRED with retryAfterMs is rejected immediately, not re-issued", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 5 },
      });
      let attempts = 0;
      await expect(
        limiter.enqueue(async () => {
          attempts++;
          throw koiError({ code: "AUTH_REQUIRED", retryable: true, retryAfterMs: 100 });
        }),
      ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      expect(attempts).toBe(1);
      expect(sleepSpy).not.toHaveBeenCalled();
    });

    it("PERMISSION with retryAfterMs is rejected immediately, not re-issued", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 5 },
      });
      let attempts = 0;
      await expect(
        limiter.enqueue(async () => {
          attempts++;
          throw koiError({ code: "PERMISSION", retryAfterMs: 100 });
        }),
      ).rejects.toMatchObject({ code: "PERMISSION" });
      expect(attempts).toBe(1);
    });
  });

  describe("decorrelated jitter widens across retries", () => {
    it("passes prevDelayMs to computeBackoff so the window grows", async () => {
      const computeBackoffSpy = spyOn(errors, "computeBackoff");
      try {
        const limiter = createRateLimiter({
          retry: {
            ...errors.DEFAULT_RETRY_CONFIG,
            maxRetries: 3,
            initialDelayMs: 100,
            maxBackoffMs: 10_000,
            jitter: true,
            jitterStrategy: "decorrelated",
          },
        });
        let attempts = 0;
        await expect(
          limiter.enqueue(async () => {
            attempts++;
            throw koiError({ code: "TIMEOUT" });
          }),
        ).rejects.toMatchObject({ code: "TIMEOUT" });

        expect(attempts).toBe(4);
        // First retry: prevDelayMs is undefined; subsequent retries pass the prior delay.
        const calls = computeBackoffSpy.mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(3);
        expect(calls[0]?.[4]).toBeUndefined();
        expect(typeof calls[1]?.[4]).toBe("number");
        expect(typeof calls[2]?.[4]).toBe("number");
      } finally {
        computeBackoffSpy.mockRestore();
      }
    });
  });

  describe("state-gated codes are not auto-retried", () => {
    it("does not auto-retry AUTH_REQUIRED even though it is retryable post-OAuth", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 5 },
      });
      let attempts = 0;
      await expect(
        limiter.enqueue(async () => {
          attempts++;
          throw koiError({ code: "AUTH_REQUIRED", retryable: true });
        }),
      ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      expect(attempts).toBe(1);
      expect(sleepSpy).not.toHaveBeenCalled();
    });

    it("does not auto-retry CONFLICT — replaying could duplicate side effects", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 5 },
      });
      let attempts = 0;
      await expect(
        limiter.enqueue(async () => {
          attempts++;
          throw koiError({ code: "CONFLICT", retryable: true });
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(attempts).toBe(1);
    });

    it("does not auto-retry RESOURCE_EXHAUSTED — tight retry would just thrash", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 5 },
      });
      let attempts = 0;
      await expect(
        limiter.enqueue(async () => {
          attempts++;
          throw koiError({ code: "RESOURCE_EXHAUSTED", retryable: true });
        }),
      ).rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });
      expect(attempts).toBe(1);
    });
  });

  describe("malformed retry hints are sanitized", () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["NaN", Number.NaN],
      ["negative", -250],
      ["-Infinity", Number.NEGATIVE_INFINITY],
    ];

    for (const [name, value] of cases) {
      it(`treats ${name} retryAfterMs as absent (no immediate hot-loop)`, async () => {
        const limiter = createRateLimiter({
          retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 5 },
        });
        let attempts = 0;
        await expect(
          limiter.enqueue(async () => {
            attempts++;
            throw koiError({ code: "PERMISSION", retryAfterMs: value });
          }),
        ).rejects.toMatchObject({ code: "PERMISSION" });
        // PERMISSION is not transport-retryable, hint was bogus → reject after 1 attempt
        expect(attempts).toBe(1);
      });
    }

    it("clamps absurdly large retryAfterMs to maxBackoffMs", async () => {
      const limiter = createRateLimiter({
        retry: {
          ...errors.DEFAULT_RETRY_CONFIG,
          maxRetries: 1,
          maxBackoffMs: 5_000,
          jitter: false,
        },
      });
      let attempts = 0;
      await limiter.enqueue(async () => {
        attempts++;
        if (attempts < 2) throw koiError({ code: "RATE_LIMIT", retryAfterMs: 9_999_999_999 });
      });
      expect(attempts).toBe(2);
      expect(sleepSpy).toHaveBeenCalledWith(5_000);
    });
  });

  it("rejects the in-flight entry and continues the queue when sleep throws", async () => {
    sleepSpy.mockImplementationOnce(() => Promise.reject(new Error("clock broken")));
    const limiter = createRateLimiter({
      retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 3, initialDelayMs: 10, jitter: false },
    });
    let attempts = 0;
    const failing = limiter.enqueue(async () => {
      attempts++;
      throw koiError({ code: "TIMEOUT" });
    });
    const completed: string[] = [];
    const after = limiter.enqueue(async () => {
      completed.push("ok");
    });
    await expect(failing).rejects.toMatchObject({ code: "TIMEOUT" });
    await after;
    expect(completed).toEqual(["ok"]);
    expect(attempts).toBe(1);
  });

  describe("classifier safety: queue keeps draining when hooks throw", () => {
    it("treats a throwing extractRetryAfterMs as non-retryable and continues the queue", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 3 },
        extractRetryAfterMs: () => {
          throw new Error("classifier blew up");
        },
      });
      const failing = limiter.enqueue(() => Promise.reject(new Error("send-fail")));
      const completed: string[] = [];
      const after = limiter.enqueue(async () => {
        completed.push("ok");
      });
      await expect(failing).rejects.toThrow("send-fail");
      await after;
      expect(completed).toEqual(["ok"]);
    });

    it("treats a throwing isRetryable as non-retryable and continues the queue", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 3 },
        isRetryable: () => {
          throw new Error("classifier blew up");
        },
      });
      const failing = limiter.enqueue(() => Promise.reject(new Error("send-fail")));
      const completed: string[] = [];
      const after = limiter.enqueue(async () => {
        completed.push("ok");
      });
      await expect(failing).rejects.toThrow("send-fail");
      await after;
      expect(completed).toEqual(["ok"]);
    });
  });

  it("size() reflects pending items", async () => {
    const limiter = createRateLimiter();
    expect(limiter.size()).toBe(0);
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((res) => {
      release = res;
    });
    const p1 = limiter.enqueue(() => blocker);
    const p2 = limiter.enqueue(() => Promise.resolve());
    expect(limiter.size()).toBeGreaterThanOrEqual(1);
    release?.();
    await Promise.all([p1, p2]);
    expect(limiter.size()).toBe(0);
  });
});
