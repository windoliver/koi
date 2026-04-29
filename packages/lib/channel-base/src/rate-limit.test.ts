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
      retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 2 },
      extractRetryAfterMs: extract,
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
      extractRetryAfterMs: () => 250,
    });
    let attempts = 0;
    const fn = async (): Promise<void> => {
      attempts++;
      throw new Error("429");
    };
    await expect(limiter.enqueue(fn)).rejects.toThrow("429");
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
