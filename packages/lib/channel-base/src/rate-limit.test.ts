import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { KoiError } from "@koi/core";
import * as errors from "@koi/errors";
import { createRateLimiter, type SendFn } from "./rate-limit.js";

const koiError = (overrides: Partial<KoiError> & Pick<KoiError, "code">): KoiError => ({
  code: overrides.code,
  message: overrides.message ?? "test",
  retryable: overrides.retryable ?? false,
  ...(overrides.retryAfterMs === undefined ? {} : { retryAfterMs: overrides.retryAfterMs }),
  ...(overrides.context === undefined ? {} : { context: overrides.context }),
});

const captureRejection = async <T>(p: Promise<T>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error("expected promise to reject");
    },
    (e: unknown) => e,
  );

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

  describe("config validation rejects malformed inputs at construction", () => {
    it("throws when retry.maxRetries is negative (would silently drop sends)", () => {
      expect(() =>
        createRateLimiter({ retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: -1 } }),
      ).toThrow(/maxRetries/);
    });

    it("throws when retry.maxRetries is non-integer", () => {
      expect(() =>
        createRateLimiter({ retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 1.5 } }),
      ).toThrow(/maxRetries/);
    });

    it("throws when sendTimeoutMs is NaN (would disable the watchdog)", () => {
      expect(() => createRateLimiter({ sendTimeoutMs: Number.NaN })).toThrow(/sendTimeoutMs/);
    });

    it("throws when sendTimeoutMs is negative", () => {
      expect(() => createRateLimiter({ sendTimeoutMs: -5 })).toThrow(/sendTimeoutMs/);
    });

    it("accepts the documented opt-out values 0 and Infinity", () => {
      expect(() => createRateLimiter({ sendTimeoutMs: 0 })).not.toThrow();
      expect(() => createRateLimiter({ sendTimeoutMs: Number.POSITIVE_INFINITY })).not.toThrow();
    });

    it("throws when retry.initialDelayMs is NaN, negative, or Infinity", () => {
      expect(() =>
        createRateLimiter({
          retry: { ...errors.DEFAULT_RETRY_CONFIG, initialDelayMs: Number.NaN },
        }),
      ).toThrow(/initialDelayMs/);
      expect(() =>
        createRateLimiter({ retry: { ...errors.DEFAULT_RETRY_CONFIG, initialDelayMs: -1 } }),
      ).toThrow(/initialDelayMs/);
      expect(() =>
        createRateLimiter({
          retry: { ...errors.DEFAULT_RETRY_CONFIG, initialDelayMs: Number.POSITIVE_INFINITY },
        }),
      ).toThrow(/initialDelayMs/);
    });

    it("throws when retry.maxBackoffMs is malformed or smaller than initialDelayMs", () => {
      expect(() =>
        createRateLimiter({ retry: { ...errors.DEFAULT_RETRY_CONFIG, maxBackoffMs: Number.NaN } }),
      ).toThrow(/maxBackoffMs/);
      expect(() =>
        createRateLimiter({
          retry: { ...errors.DEFAULT_RETRY_CONFIG, initialDelayMs: 1000, maxBackoffMs: 100 },
        }),
      ).toThrow(/maxBackoffMs/);
    });

    it("throws when retry.backoffMultiplier is not finite-positive", () => {
      expect(() =>
        createRateLimiter({
          retry: { ...errors.DEFAULT_RETRY_CONFIG, backoffMultiplier: Number.NaN },
        }),
      ).toThrow(/backoffMultiplier/);
      expect(() =>
        createRateLimiter({
          retry: { ...errors.DEFAULT_RETRY_CONFIG, backoffMultiplier: 0 },
        }),
      ).toThrow(/backoffMultiplier/);
      expect(() =>
        createRateLimiter({
          retry: { ...errors.DEFAULT_RETRY_CONFIG, backoffMultiplier: -1 },
        }),
      ).toThrow(/backoffMultiplier/);
    });
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
    expect(await captureRejection(limiter.enqueue(() => Promise.reject(err)))).toBe(err);
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
    const __rejErr1 = await captureRejection(limiter.enqueue(fn));
    expect(__rejErr1).toBeInstanceOf(Error);
    expect((__rejErr1 as Error).message).toContain("permission denied");
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
    expect(await captureRejection(limiter.enqueue(fn))).toMatchObject({ code: "RATE_LIMIT" });
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
    const __rejErr2 = await captureRejection(failing);
    expect(__rejErr2).toBeInstanceOf(Error);
    expect((__rejErr2 as Error).message).toContain("x");
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

    it("retries a KoiError whose code is in the retryable set (RATE_LIMIT)", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 1, initialDelayMs: 25, jitter: false },
      });
      let attempts = 0;
      await limiter.enqueue(async () => {
        attempts++;
        if (attempts < 2) throw koiError({ code: "RATE_LIMIT" });
      });
      expect(attempts).toBe(2);
      expect(sleepSpy).toHaveBeenCalledWith(25);
    });

    it("opt-in TIMEOUT retries with caller-provided extractor honor retryAfterMs", async () => {
      // Loop-5 round 10: the default extractor deliberately does NOT
      // surface TIMEOUT.retryAfterMs (gated to RATE_LIMIT only) — that
      // would auto-replay TIMEOUT sends and reintroduce the
      // duplicate-delivery hazard. Callers who opt TIMEOUT into retry
      // (because they have provider-side idempotency) and want the
      // server cooldown honored MUST supply their own extractRetryAfterMs.
      const limiter = createRateLimiter({
        retry: {
          ...errors.DEFAULT_RETRY_CONFIG,
          maxRetries: 1,
          jitter: false,
          maxBackoffMs: 120_000,
        },
        isRetryable: (e) =>
          typeof e === "object" && e !== null && (e as { code?: string }).code === "TIMEOUT",
        extractRetryAfterMs: (e) => {
          if (typeof e === "object" && e !== null) {
            const r = (e as { retryAfterMs?: unknown }).retryAfterMs;
            if (typeof r === "number") return r;
          }
          return undefined;
        },
      });
      let attempts = 0;
      await limiter.enqueue(async () => {
        attempts++;
        if (attempts < 2)
          throw koiError({ code: "TIMEOUT", retryAfterMs: 60_000, retryable: true });
      });
      expect(attempts).toBe(2);
      expect(sleepSpy).toHaveBeenCalledWith(60_000);
    });

    it("default extractor does NOT auto-replay TIMEOUT even when retryAfterMs is set", async () => {
      // Regression: loop-5 round 10 finding 1. A bare
      // { code: "TIMEOUT", retryAfterMs: 60_000 } from a transport
      // must NOT trigger automatic retry under default policy — request
      // status is unknown and the send may have completed before the
      // local watchdog fired. Explicit opt-in via custom isRetryable +
      // extractRetryAfterMs is required.
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 5 },
      });
      let attempts = 0;
      expect(
        await captureRejection(
          limiter.enqueue(async () => {
            attempts++;
            throw koiError({ code: "TIMEOUT", retryAfterMs: 60_000, retryable: true });
          }),
        ),
      ).toMatchObject({ code: "TIMEOUT" });
      expect(attempts).toBe(1);
    });

    it("does not auto-retry TIMEOUT — request status is unknown", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 5 },
      });
      let attempts = 0;
      expect(
        await captureRejection(
          limiter.enqueue(async () => {
            attempts++;
            throw koiError({ code: "TIMEOUT", retryable: true });
          }),
        ),
      ).toMatchObject({ code: "TIMEOUT" });
      expect(attempts).toBe(1);
      expect(sleepSpy).not.toHaveBeenCalled();
    });

    it("rejects a KoiError whose code is not retryable without re-issuing", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 5 },
      });
      let attempts = 0;
      expect(
        await captureRejection(
          limiter.enqueue(async () => {
            attempts++;
            throw koiError({ code: "PERMISSION" });
          }),
        ),
      ).toMatchObject({ code: "PERMISSION" });
      expect(attempts).toBe(1);
      expect(sleepSpy).not.toHaveBeenCalled();
    });

    it("rejects a non-KoiError thrown without re-issuing", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 3 },
      });
      let attempts = 0;
      const __rejErr3 = await captureRejection(
        limiter.enqueue(async () => {
          attempts++;
          throw new Error("plain transport blip");
        }),
      );
      expect(__rejErr3).toBeInstanceOf(Error);
      expect((__rejErr3 as Error).message).toContain("plain transport blip");
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
      expect(
        await captureRejection(
          limiter.enqueue(async () => {
            attempts++;
            throw koiError({ code: "AUTH_REQUIRED", retryable: true, retryAfterMs: 100 });
          }),
        ),
      ).toMatchObject({ code: "AUTH_REQUIRED" });
      expect(attempts).toBe(1);
      expect(sleepSpy).not.toHaveBeenCalled();
    });

    it("PERMISSION with retryAfterMs is rejected immediately, not re-issued", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 5 },
      });
      let attempts = 0;
      expect(
        await captureRejection(
          limiter.enqueue(async () => {
            attempts++;
            throw koiError({ code: "PERMISSION", retryAfterMs: 100 });
          }),
        ),
      ).toMatchObject({ code: "PERMISSION" });
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
        expect(
          await captureRejection(
            limiter.enqueue(async () => {
              attempts++;
              throw koiError({ code: "RATE_LIMIT" });
            }),
          ),
        ).toMatchObject({ code: "RATE_LIMIT" });

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
      expect(
        await captureRejection(
          limiter.enqueue(async () => {
            attempts++;
            throw koiError({ code: "AUTH_REQUIRED", retryable: true });
          }),
        ),
      ).toMatchObject({ code: "AUTH_REQUIRED" });
      expect(attempts).toBe(1);
      expect(sleepSpy).not.toHaveBeenCalled();
    });

    it("does not auto-retry CONFLICT — replaying could duplicate side effects", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 5 },
      });
      let attempts = 0;
      expect(
        await captureRejection(
          limiter.enqueue(async () => {
            attempts++;
            throw koiError({ code: "CONFLICT", retryable: true });
          }),
        ),
      ).toMatchObject({ code: "CONFLICT" });
      expect(attempts).toBe(1);
    });

    it("does not auto-retry RESOURCE_EXHAUSTED — tight retry would just thrash", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 5 },
      });
      let attempts = 0;
      expect(
        await captureRejection(
          limiter.enqueue(async () => {
            attempts++;
            throw koiError({ code: "RESOURCE_EXHAUSTED", retryable: true });
          }),
        ),
      ).toMatchObject({ code: "RESOURCE_EXHAUSTED" });
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
        expect(
          await captureRejection(
            limiter.enqueue(async () => {
              attempts++;
              throw koiError({ code: "PERMISSION", retryAfterMs: value });
            }),
          ),
        ).toMatchObject({ code: "PERMISSION" });
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

  describe("onInternalError surfaces retry-path failures", () => {
    it("reports a thrown extractRetryAfterMs as 'extract'", async () => {
      const reports: Array<readonly [string, unknown]> = [];
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 2 },
        extractRetryAfterMs: () => {
          throw new Error("ext-broken");
        },
        onInternalError: (stage, err) => {
          reports.push([stage, err]);
        },
      });
      const __rejErr4 = await captureRejection(
        limiter.enqueue(() => Promise.reject(new Error("send-fail"))),
      );
      expect(__rejErr4).toBeInstanceOf(Error);
      expect((__rejErr4 as Error).message).toContain("send-fail");
      expect(
        reports.some(
          ([s, e]) => s === "extract" && e instanceof Error && e.message === "ext-broken",
        ),
      ).toBe(true);
    });

    it("reports a thrown isRetryable as 'classify'", async () => {
      const reports: Array<readonly [string, unknown]> = [];
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 2 },
        isRetryable: () => {
          throw new Error("classify-broken");
        },
        onInternalError: (stage, err) => {
          reports.push([stage, err]);
        },
      });
      const __rejErr5 = await captureRejection(
        limiter.enqueue(() => Promise.reject(new Error("send-fail"))),
      );
      expect(__rejErr5).toBeInstanceOf(Error);
      expect((__rejErr5 as Error).message).toContain("send-fail");
      expect(reports.some(([s]) => s === "classify")).toBe(true);
    });

    it("reports a thrown sleep as 'sleep'", async () => {
      sleepSpy.mockImplementationOnce(() => Promise.reject(new Error("clock-broken")));
      const reports: Array<readonly [string, unknown]> = [];
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 3, initialDelayMs: 10, jitter: false },
        onInternalError: (stage, err) => {
          reports.push([stage, err]);
        },
      });
      expect(
        await captureRejection(
          limiter.enqueue(() => Promise.reject(koiError({ code: "RATE_LIMIT" }))),
        ),
      ).toMatchObject({ code: "RATE_LIMIT" });
      expect(
        reports.some(
          ([s, e]) => s === "sleep" && e instanceof Error && e.message === "clock-broken",
        ),
      ).toBe(true);
    });

    it("swallows hook errors so they cannot wedge the queue", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 1 },
        isRetryable: () => {
          throw new Error("classify-broken");
        },
        onInternalError: () => {
          throw new Error("hook-broken");
        },
      });
      const __rejErr6 = await captureRejection(
        limiter.enqueue(() => Promise.reject(new Error("send-fail"))),
      );
      expect(__rejErr6).toBeInstanceOf(Error);
      expect((__rejErr6 as Error).message).toContain("send-fail");
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
      throw koiError({ code: "RATE_LIMIT" });
    });
    const completed: string[] = [];
    const after = limiter.enqueue(async () => {
      completed.push("ok");
    });
    expect(await captureRejection(failing)).toMatchObject({ code: "RATE_LIMIT" });
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
      const __rejErr7 = await captureRejection(failing);
      expect(__rejErr7).toBeInstanceOf(Error);
      expect((__rejErr7 as Error).message).toContain("send-fail");
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
      const __rejErr8 = await captureRejection(failing);
      expect(__rejErr8).toBeInstanceOf(Error);
      expect((__rejErr8 as Error).message).toContain("send-fail");
      await after;
      expect(completed).toEqual(["ok"]);
    });
  });

  it("size() reflects pending items", async () => {
    const limiter = createRateLimiter({ sendTimeoutMs: 0 });
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

  describe("sendTimeoutMs prevents a hung send from wedging the queue", () => {
    // Helper: a send callback that resolves immediately when its abort
    // signal fires. Models a well-behaved transport that honors cancellation.
    const cancelOnAbort: SendFn = (signal) =>
      new Promise<void>((_resolve, reject) => {
        // Compliant adapter: when honoring abort, rejects with a TIMEOUT
        // KoiError so the late-outcome path surfaces TIMEOUT semantics
        // upstream (instead of an opaque "aborted" Error).
        const timeoutErr: KoiError = {
          code: "TIMEOUT",
          message: "aborted",
          retryable: false,
          context: { phase: "deadline-exceeded" },
        };
        if (signal.aborted) return reject(timeoutErr);
        signal.addEventListener("abort", () => reject(timeoutErr), { once: true });
      });

    it("rejects the in-flight entry with TIMEOUT KoiError after the deadline", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 25,
      });
      const start = Date.now();
      expect(await captureRejection(limiter.enqueue(cancelOnAbort))).toMatchObject({
        code: "TIMEOUT",
      });
      expect(Date.now() - start).toBeLessThan(2_000);
    });

    it("calls onSendTimeout for each timed-out attempt", async () => {
      const onSendTimeout = mock(() => {});
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 15,
        onSendTimeout,
      });
      expect(await captureRejection(limiter.enqueue(cancelOnAbort))).toMatchObject({
        code: "TIMEOUT",
      });
      expect(onSendTimeout).toHaveBeenCalledTimes(1);
    });

    it("continues draining the queue after a hung entry is timed out", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 15,
      });
      const hung = limiter.enqueue(cancelOnAbort);
      const completed: string[] = [];
      const after = limiter.enqueue(async () => {
        completed.push("ok");
      });
      expect(await captureRejection(hung)).toMatchObject({ code: "TIMEOUT" });
      await after;
      expect(completed).toEqual(["ok"]);
    });

    it("default mode upgrades final-attempt TIMEOUT to real outcome (no duplicate-send hazard)", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 50,
      });
      const events: string[] = [];
      // Slow-but-compliant: resolves 20ms after the deadline.
      const slowButSettles: SendFn = () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            events.push("A-finished");
            resolve();
          }, 70);
        });
      const a = limiter.enqueue(slowButSettles);
      const b = limiter.enqueue(async () => {
        events.push("B-sent");
      });
      // Strict mode awaits real settle on the final attempt (the queue
      // is already going to wait for advance, so this adds no latency).
      // Late success → caller resolves with no duplicate-send hazard.
      expect(await a).toBeUndefined();
      await b;
      expect(events).toEqual(["A-finished", "B-sent"]);
    });

    it("grace backstop unwedges the queue ONLY in liveness mode", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 25,
        advanceOnTimeout: true,
      });
      // Abort-ignoring transport that never settles.
      const ignoresAbort: SendFn = () => new Promise<void>(() => {});
      const start = Date.now();
      const a = limiter.enqueue(ignoresAbort);
      const bDelivered: string[] = [];
      const b = limiter.enqueue(async () => {
        bDelivered.push("ok");
      });
      expect(await captureRejection(a)).toMatchObject({ code: "TIMEOUT" });
      await b;
      expect(bDelivered).toEqual(["ok"]);
      // Total stall is bounded at ~2× sendTimeoutMs (deadline + grace).
      expect(Date.now() - start).toBeLessThan(500);
    });

    it("liveness mode rejects the caller promptly at the deadline (no late-outcome wait)", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 20,
        advanceOnTimeout: true,
      });
      // Transport that takes 200ms, far longer than sendTimeoutMs.
      const slow: SendFn = () => new Promise<void>((resolve) => setTimeout(resolve, 200));
      const start = Date.now();
      expect(await captureRejection(limiter.enqueue(slow))).toMatchObject({ code: "TIMEOUT" });
      const elapsed = Date.now() - start;
      // Liveness mode: caller-facing rejection fires at the deadline,
      // NOT at fnPromise settlement. Allow some scheduler slack.
      expect(elapsed).toBeLessThan(80);
    });

    describe("advanceOnTimeout: true (liveness mode, opt-in)", () => {
      it("advances the queue immediately when a send ignores abort", async () => {
        const limiter = createRateLimiter({
          retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
          sendTimeoutMs: 15,
          advanceOnTimeout: true,
        });
        // Abort-ignoring send: never honors the signal. In strict-FIFO mode
        // this would wedge the queue forever.
        const ignoresAbort: SendFn = () => new Promise<void>(() => {});
        const a = limiter.enqueue(ignoresAbort);
        const bDelivered: string[] = [];
        const b = limiter.enqueue(async () => {
          bDelivered.push("ok");
        });
        expect(await captureRejection(a)).toMatchObject({ code: "TIMEOUT" });
        await b;
        expect(bDelivered).toEqual(["ok"]);
      });

      it("surfaces late resolution via onLateSuccess for telemetry", async () => {
        const onLateSuccess = mock(() => {});
        const limiter = createRateLimiter({
          retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
          sendTimeoutMs: 15,
          advanceOnTimeout: true,
          onLateSuccess,
        });
        const slowAfterAbort: SendFn = () =>
          new Promise<void>((resolve) => {
            setTimeout(() => resolve(), 60);
          });
        expect(await captureRejection(limiter.enqueue(slowAfterAbort))).toMatchObject({
          code: "TIMEOUT",
        });
        await new Promise((res) => setTimeout(res, 80));
        expect(onLateSuccess).toHaveBeenCalledTimes(1);
      });

      it("surfaces late rejection via onLateFailure for telemetry", async () => {
        const onLateFailure = mock((_e: unknown) => {});
        const limiter = createRateLimiter({
          retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
          sendTimeoutMs: 15,
          advanceOnTimeout: true,
          onLateFailure,
        });
        const slowReject: SendFn = () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error("late-boom")), 60);
          });
        expect(await captureRejection(limiter.enqueue(slowReject))).toMatchObject({
          code: "TIMEOUT",
        });
        await new Promise((res) => setTimeout(res, 80));
        expect(onLateFailure).toHaveBeenCalledTimes(1);
        expect(onLateFailure).toHaveBeenCalledWith(
          expect.objectContaining({ message: "late-boom" }),
        );
      });
    });

    it("strict-mode upgraded success does NOT fire onLateSuccess (caller never saw a synthetic TIMEOUT)", async () => {
      // Regression: loop-5 round 7 finding 3. Late hooks must only fire
      // when the caller actually received the synthetic deadline error.
      // In strict mode, the loop UPGRADES the caller's outcome to the
      // real result; firing onLateSuccess there is misleading telemetry.
      const onLateSuccess = mock(() => {});
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 20,
        // advanceOnTimeout NOT set → strict mode
        onLateSuccess,
      });
      // Resolves at +30ms — past sendTimeoutMs (20ms) but within the
      // bounded final-attempt grace window (another 20ms = 40ms total).
      const slowSuccess: SendFn = () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 30);
        });
      await limiter.enqueue(slowSuccess);
      await new Promise((res) => setTimeout(res, 50));
      // Caller saw the upgraded real success — no late hook should fire.
      expect(onLateSuccess).toHaveBeenCalledTimes(0);
    });

    it("retries serialize on prior settle even in liveness mode (no overlapping invocations of the same fn)", async () => {
      // Force retry classification by making each attempt late-fail with a
      // RATE_LIMIT (default-retryable). Without per-attempt serialization,
      // the second attempt could start while attempt 1's transport is still
      // running — duplicate-send hazard.
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 1, initialDelayMs: 0 },
        sendTimeoutMs: 30,
        advanceOnTimeout: true,
      });
      let inFlight = 0;
      let maxConcurrent = 0;
      const rateLimitErr: KoiError = {
        code: "RATE_LIMIT",
        message: "throttled",
        retryable: true,
      };
      const fn: SendFn = () =>
        new Promise<void>((_resolve, reject) => {
          inFlight++;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          // Settles 50ms after start with a retryable error; deadline at 30ms.
          setTimeout(() => {
            inFlight--;
            reject(rateLimitErr);
          }, 50);
        });
      // Final attempt's caller-facing error is the synthetic TIMEOUT
      // (prompt rejection on no-more-retries) — late RATE_LIMIT only
      // affects internal retry classification on non-final attempts.
      expect(await captureRejection(limiter.enqueue(fn))).toMatchObject({ code: "TIMEOUT" });
      // Two attempts ran but never overlapped.
      expect(maxConcurrent).toBe(1);
    });

    it("late-success after deadline TIMEOUT resolves the caller (real outcome wins)", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 1, initialDelayMs: 0 },
        sendTimeoutMs: 30,
        isRetryable: (e: unknown): boolean =>
          typeof e === "object" && e !== null && (e as { code?: string }).code === "TIMEOUT",
      });
      // Settles successfully 50ms after start (after deadline, before grace expires).
      const fn: SendFn = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
      // The synthetic TIMEOUT would have triggered a retry under the
      // custom isRetryable, but the late success is observed first and
      // wins — no retry, caller resolves.
      expect(await limiter.enqueue(fn)).toBeUndefined();
    });

    it("late terminal failure replaces the synthetic TIMEOUT for retry classification", async () => {
      // Custom isRetryable opts TIMEOUT into retry. But if the underlying
      // send late-fails with a terminal PERMISSION (not retryable), we
      // must NOT retry — the real outcome overrides the synthetic timeout.
      let attempts = 0;
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 3, initialDelayMs: 0 },
        sendTimeoutMs: 30,
        isRetryable: (e: unknown): boolean =>
          typeof e === "object" && e !== null && (e as { code?: string }).code === "TIMEOUT",
      });
      const permErr: KoiError = {
        code: "PERMISSION",
        message: "denied",
        retryable: false,
      };
      const fn: SendFn = () =>
        new Promise<void>((_resolve, reject) => {
          attempts++;
          setTimeout(() => reject(permErr), 50);
        });
      expect(await captureRejection(limiter.enqueue(fn))).toMatchObject({ code: "PERMISSION" });
      // Real terminal error wins over synthetic TIMEOUT — no retries.
      expect(attempts).toBe(1);
    });

    it("strict mode never overlaps next-entry advance with a still-running send", async () => {
      // Abort-honoring slow transport: settles via abort 80ms after start.
      // No grace backstop in default mode → next entry MUST wait.
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 20,
      });
      let inFlight = 0;
      let maxConcurrent = 0;
      const slowAbortHonoring: SendFn = (signal) =>
        new Promise<void>((_resolve, reject) => {
          inFlight++;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          // Honors abort within the final-attempt grace window so the
          // late outcome is observed as a real terminal failure (not
          // delivery-unknown). Strict mode then advances only after
          // settle — no overlap with the next entry.
          const onAbort = (): void => {
            setTimeout(() => {
              inFlight--;
              const e: KoiError = {
                code: "TIMEOUT",
                message: "abort honored",
                retryable: false,
              };
              reject(e);
            }, 10);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      const a = limiter.enqueue(slowAbortHonoring);
      const b = limiter.enqueue(async () => {
        // Fail loudly if A is still in-flight when B starts.
        expect(inFlight).toBe(0);
      });
      expect(await captureRejection(a)).toMatchObject({ code: "TIMEOUT" });
      await b;
      expect(maxConcurrent).toBe(1);
    });

    it("strict mode never overlaps retry attempts of the same fn", async () => {
      // Custom isRetryable opts TIMEOUT into retry. Each attempt rejects
      // late (after abort, within the bounded grace) with a retryable
      // code. Strict mode must serialize: attempt N+1 never starts
      // while attempt N is in flight.
      //
      // Loop-6 round 5 update: pre-retry wait is now bounded at
      // sendTimeoutMs to defend against abort-ignoring transports
      // (queue-wedge defense). Transports that honor abort but settle
      // late within the grace still flow through the retry path
      // unchanged — this test rejects at +10ms (well inside the 20ms
      // grace) so the late outcome is observed as RATE_LIMIT.
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 2, initialDelayMs: 0 },
        sendTimeoutMs: 20,
      });
      let inFlight = 0;
      let maxConcurrent = 0;
      let attempts = 0;
      const fn: SendFn = (signal) =>
        new Promise<void>((_resolve, reject) => {
          attempts++;
          inFlight++;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          const onAbort = (): void => {
            setTimeout(() => {
              inFlight--;
              const e: KoiError = {
                code: "RATE_LIMIT",
                message: "throttled",
                retryable: true,
              };
              reject(e);
            }, 10);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      // Final-attempt rejection is the late RATE_LIMIT (real outcome
      // wins), surfaced to the caller as RATE_LIMIT not synthetic TIMEOUT.
      expect(await captureRejection(limiter.enqueue(fn))).toMatchObject({ code: "RATE_LIMIT" });
      // Three attempts (initial + 2 retries), never overlapping.
      expect(attempts).toBe(3);
      expect(maxConcurrent).toBe(1);
    });

    it("strict-mode caller does not hang on a final-attempt deadline when the transport ignores abort", async () => {
      // Regression: Round 7 finding 1 + Round 10 finding 1. Final-attempt
      // strict-mode upgrade must be bounded so an abort-ignoring transport
      // cannot wedge the caller. When the real outcome remains unknown
      // after the grace window, surface a distinct delivery-unknown
      // error (retryable: false, phase: "delivery-unknown") so callers
      // do not conflate it with a normal retryable TIMEOUT.
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 20,
      });
      const neverSettles: SendFn = () => new Promise<void>(() => {});
      const start = Date.now();
      expect(await captureRejection(limiter.enqueue(neverSettles))).toMatchObject({
        code: "TIMEOUT",
        retryable: false,
        context: { phase: "delivery-unknown" },
      });
      // Should complete in roughly sendTimeoutMs + a small grace, not 200+ms.
      expect(Date.now() - start).toBeLessThan(150);
    });

    it("strict-mode delivery-unknown does not wedge later enqueued sends", async () => {
      // Regression: loop-5 round 2 finding 1. After a final-attempt
      // delivery-unknown the unbounded queue-advance gate would still
      // wait on lastSettled forever if the transport ignored abort,
      // turning one bad send into a channel outage. The advance gate
      // is now bounded for that specific terminal state.
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 20,
      });
      const neverSettles: SendFn = () => new Promise<void>(() => {});
      const a = limiter.enqueue(neverSettles);
      const completed: string[] = [];
      const b = limiter.enqueue(async () => {
        completed.push("ok");
      });
      expect(await captureRejection(a)).toMatchObject({
        context: { phase: "delivery-unknown" },
      });
      // b must complete despite a's transport never settling.
      const start = Date.now();
      await b;
      expect(completed).toEqual(["ok"]);
      // Should be bounded at ~sendTimeoutMs (one extra grace), not blocked forever.
      expect(Date.now() - start).toBeLessThan(150);
    });

    it("strict-mode never reports a definitive TIMEOUT for a send that succeeds after the grace window", async () => {
      // Regression: Round 10 finding 1. If the transport eventually
      // succeeds AFTER the bounded grace window, the caller must NOT
      // have been told it was a normal TIMEOUT (which is retryable by
      // default). The caller sees delivery-unknown — the contract
      // says do not retry blindly.
      const lateOutcomes: string[] = [];
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 20,
        onLateSuccess: () => lateOutcomes.push("late-success"),
      });
      // Resolves at +60ms — well past the bounded final-attempt grace.
      const slowSuccess: SendFn = () => new Promise<void>((resolve) => setTimeout(resolve, 60));
      expect(await captureRejection(limiter.enqueue(slowSuccess))).toMatchObject({
        code: "TIMEOUT",
        retryable: false,
        context: { phase: "delivery-unknown" },
      });
      // Late success eventually flows to the telemetry hook.
      await new Promise<void>((res) => setTimeout(res, 80));
      expect(lateOutcomes).toEqual(["late-success"]);
    });

    it("liveness mode does not reissue a send when the first attempt succeeds during the backoff sleep", async () => {
      // Regression: loop-5 round 1 finding 2. The recheck before sleep
      // does not cover a settlement that lands DURING the sleep window.
      // The implementation now races sleep(delay) against run.settled
      // and rechecks the late outcome after the sleep.
      let attempts = 0;
      const limiter = createRateLimiter({
        retry: {
          ...errors.DEFAULT_RETRY_CONFIG,
          maxRetries: 1,
          initialDelayMs: 80,
          jitter: false,
        },
        isRetryable: (e) =>
          typeof e === "object" && e !== null && (e as { code?: string }).code === "TIMEOUT",
        sendTimeoutMs: 20,
        advanceOnTimeout: true,
      });
      // First attempt: still pending after 20ms grace AND 20ms second wait,
      // but resolves at +60ms — i.e. during the 80ms backoff sleep.
      const fn: SendFn = () =>
        new Promise<void>((resolve) => {
          attempts++;
          setTimeout(resolve, 60);
        });
      await limiter.enqueue(fn);
      expect(attempts).toBe(1);
    });

    it("liveness mode does not reissue a send when the first attempt succeeds during the second wait", async () => {
      // Regression: Round 7 finding 2. After computing backoff, we wait
      // again on run.settled (bounded in liveness). If the first attempt
      // resolves during this second wait, we must short-circuit instead
      // of launching a duplicate send.
      let attempts = 0;
      const limiter = createRateLimiter({
        retry: {
          ...errors.DEFAULT_RETRY_CONFIG,
          maxRetries: 1,
          initialDelayMs: 50,
        },
        isRetryable: (e) =>
          typeof e === "object" && e !== null && (e as { code?: string }).code === "TIMEOUT",
        sendTimeoutMs: 20,
        advanceOnTimeout: true,
      });
      // First attempt resolves at ~40ms — after the first 20ms grace
      // (which classifies the synthetic TIMEOUT as retryable) and
      // during the second wait (which is also bounded at 20ms).
      const fn: SendFn = () =>
        new Promise<void>((resolve) => {
          attempts++;
          setTimeout(resolve, 40);
        });
      await limiter.enqueue(fn);
      expect(attempts).toBe(1);
    });

    it("non-Promise return from a JS callback resolves instead of orphaning the queue", async () => {
      // Regression: Round 9 finding 1. The package is consumable from
      // plain JS, so a buggy adapter may return undefined instead of a
      // Promise. invoke() must normalize via Promise.resolve so the
      // queue entry settles and subsequent sends proceed.
      const limiter = createRateLimiter();
      // biome-ignore lint/suspicious/noExplicitAny: simulating untyped JS caller
      const badReturn: any = () => undefined;
      await limiter.enqueue(badReturn);
      const completed: string[] = [];
      await limiter.enqueue(async () => {
        completed.push("ok");
      });
      expect(completed).toEqual(["ok"]);
    });

    it("synchronous throws in the send callback reject the caller and unblock the queue", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
      });
      const syncBoom: SendFn = () => {
        throw new Error("sync-boom");
      };
      // Caller must reject promptly, not hang forever.
      const __rejErr9 = await captureRejection(limiter.enqueue(syncBoom));
      expect(__rejErr9).toBeInstanceOf(Error);
      expect((__rejErr9 as Error).message).toContain("sync-boom");
      // Queue must keep draining: a subsequent normal send completes.
      const completed: string[] = [];
      await limiter.enqueue(async () => {
        completed.push("ok");
      });
      expect(completed).toEqual(["ok"]);
    });

    it("late RATE_LIMIT during liveness backoff sleep honors the real retryAfterMs cooldown", async () => {
      // Regression: loop-6 round 10 finding 1. In liveness mode the
      // backoff sleep is raced against run.settled. If the timed-out
      // attempt resolves DURING that sleep with a real retryable error
      // carrying `retryAfterMs`, the post-sleep recheck previously
      // updated retryability but never honored the real cooldown —
      // reissuing immediately and hammering the throttling provider.
      // Uses real timers (sleepSpy restored) so the post-sleep late-
      // settlement window can be deterministically reached: real
      // settlement at +60ms, while the first synthetic-TIMEOUT backoff
      // is 200ms, so the race transitions through state[run.settled]
      // ~140ms before the synthetic-TIMEOUT-derived sleep would have
      // ended.
      sleepSpy.mockRestore();
      const realSleeps: number[] = [];
      const realSpy = spyOn(errors, "sleep").mockImplementation(async (ms: number) => {
        realSleeps.push(ms);
        await new Promise<void>((res) => setTimeout(res, ms));
      });
      try {
        const limiter = createRateLimiter({
          retry: {
            ...errors.DEFAULT_RETRY_CONFIG,
            maxRetries: 1,
            initialDelayMs: 200,
            jitter: false,
          },
          sendTimeoutMs: 20,
          advanceOnTimeout: true,
          isRetryable: (e: unknown): boolean =>
            typeof e === "object" && e !== null && (e as { code?: string }).code === "TIMEOUT",
        });
        let attempts = 0;
        const fn: SendFn = (signal) =>
          new Promise<void>((_resolve, reject) => {
            attempts++;
            if (attempts === 1) {
              // Real settlement at +120ms — past BOTH bounded waits
              // (deadline 20ms + first 20ms grace + second 20ms grace
              // race = 60ms total), and inside the 200ms backoff sleep
              // race. This forces the post-sleep recheck path.
              setTimeout(() => {
                const e: KoiError = {
                  code: "RATE_LIMIT",
                  message: "throttled",
                  retryable: true,
                  retryAfterMs: 500,
                };
                reject(e);
              }, 120);
              void signal;
            } else {
              _resolve();
            }
          });
        await limiter.enqueue(fn);
        // First sleep is the 200ms synthetic-TIMEOUT backoff. Post-
        // sleep recheck must additionally sleep the remaining cooldown:
        // 500 - 200 = 300ms.
        expect(realSleeps).toContain(300);
        expect(attempts).toBe(2);
      } finally {
        realSpy.mockRestore();
        // Re-mock for any subsequent tests in this describe block
        // (afterEach already restores, but we replaced the spy).
        sleepSpy = spyOn(errors, "sleep").mockImplementation(() => Promise.resolve());
      }
    });

    it("late RATE_LIMIT with retryAfterMs reclassifies BOTH retryability and backoff delay", async () => {
      // Regression: loop-6 round 6 finding 1. When a synthetic TIMEOUT
      // is later replaced by a real failure carrying `retryAfterMs`,
      // both retryability AND the delay must be recomputed from the
      // real error. Previously the delay was frozen at the synthetic-
      // TIMEOUT classification, so a late `RATE_LIMIT { retryAfterMs:
      // 1000 }` would still reissue with the synthetic backoff —
      // ignoring the server cooldown and hammering the provider.
      const limiter = createRateLimiter({
        retry: {
          ...errors.DEFAULT_RETRY_CONFIG,
          maxRetries: 1,
          initialDelayMs: 5,
          jitter: false,
        },
        sendTimeoutMs: 20,
        advanceOnTimeout: true,
        // Caller opts TIMEOUT into retry.
        isRetryable: (e: unknown): boolean =>
          typeof e === "object" && e !== null && (e as { code?: string }).code === "TIMEOUT",
      });
      let attempts = 0;
      const fn: SendFn = (signal) =>
        new Promise<void>((_resolve, reject) => {
          attempts++;
          // First attempt: never resolves until aborted, then rejects
          // late with a real RATE_LIMIT carrying retryAfterMs:250.
          // Second attempt (if reissued): succeed.
          if (attempts === 1) {
            const onAbort = (): void => {
              setTimeout(() => {
                const e: KoiError = {
                  code: "RATE_LIMIT",
                  message: "throttled",
                  retryable: true,
                  retryAfterMs: 250,
                };
                reject(e);
              }, 5);
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          } else {
            _resolve();
          }
        });
      await limiter.enqueue(fn);
      // sleepSpy was called between attempts. The delay MUST equal the
      // server cooldown (250ms), not the synthetic-TIMEOUT backoff (5ms).
      expect(sleepSpy).toHaveBeenCalledWith(250);
      expect(sleepSpy).not.toHaveBeenCalledWith(5);
      expect(attempts).toBe(2);
    });

    it("strict-mode TIMEOUT-retry path bounds the late-outcome wait against abort-ignoring transports", async () => {
      // Regression: loop-6 round 5 finding 1. When a caller opts TIMEOUT
      // into retry (because they have provider-side idempotency), the
      // strict-mode pre-retry wait used to be unbounded — an abort-ignoring
      // transport would wedge the queue indefinitely before reaching the
      // final-attempt safeguard. The non-final-attempt path must now bound
      // the wait at sendTimeoutMs and surface delivery-unknown when the
      // real outcome stays unknown.
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 3, initialDelayMs: 0 },
        sendTimeoutMs: 20,
        // Caller opts in: TIMEOUT counts as retryable.
        isRetryable: (e: unknown): boolean =>
          typeof e === "object" && e !== null && (e as { code?: string }).code === "TIMEOUT",
      });
      // Transport completely ignores abort and never settles.
      const neverSettles: SendFn = () => new Promise<void>(() => {});
      const start = Date.now();
      const result = await captureRejection(limiter.enqueue(neverSettles));
      // Must complete in roughly sendTimeoutMs + a small grace, not hang.
      expect(Date.now() - start).toBeLessThan(200);
      expect(result).toMatchObject({
        code: "TIMEOUT",
        retryable: false,
        context: { phase: "delivery-unknown" },
      });
      // Subsequent sends must not be starved.
      const completed: string[] = [];
      await limiter.enqueue(async () => {
        completed.push("ok");
      });
      expect(completed).toEqual(["ok"]);
    });

    it("re-arms drain after late enqueue between final empty-check and clearing processing", async () => {
      // Regression: loop-6 round 2 finding 1. Drain shutdown previously
      // had a lost-wakeup race: between the final `while (queue.length > 0)`
      // check and the `finally { processing = false }` clearing, an
      // enqueue() could append a new entry whose own drain() call would
      // see processing===true and early-return. Without the post-clear
      // recheck the new entry would sit in the queue forever.
      //
      // Force the race deterministically: the first send's resolve is
      // wrapped to enqueue a second send AFTER the await unblocks the
      // drain loop, exercising the same scheduler ordering as a real
      // race: micro-task chain (drain await result) → next-tick enqueue.
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 0,
      });
      const completed: string[] = [];
      let secondPromise: Promise<void> | undefined;
      // First enqueue: when its send resolves, the drain loop's
      // `await run.result` returns. Schedule a NEW enqueue on the next
      // micro-task — that lands during the narrow window between the
      // final queue.length check and processing being cleared.
      const firstPromise = limiter.enqueue(async () => {
        completed.push("first");
        // Tail-schedule the second enqueue for the moment after the
        // drain loop sees queue.length === 0.
        Promise.resolve().then(() => {
          secondPromise = limiter.enqueue(async () => {
            completed.push("second");
          });
        });
      });
      await firstPromise;
      // Give the rescheduled enqueue + recheck a tick to fire.
      await new Promise((res) => setTimeout(res, 5));
      // Without the lost-wakeup guard, secondPromise either stays
      // pending forever or completed never includes "second".
      if (secondPromise === undefined) throw new Error("second was not scheduled");
      await secondPromise;
      expect(completed).toEqual(["first", "second"]);
    });

    it("opting out with sendTimeoutMs:0 leaves a hung send pending (no auto-reject)", async () => {
      const limiter = createRateLimiter({ sendTimeoutMs: 0 });
      let release: (() => void) | undefined;
      const blocker = new Promise<void>((res) => {
        release = res;
      });
      const p = limiter.enqueue(() => blocker);
      const winner = await Promise.race([
        p.then(() => "settled" as const),
        new Promise<"timer">((res) => setTimeout(() => res("timer"), 60)),
      ]);
      expect(winner).toBe("timer");
      release?.();
      await p;
    });

    it("swallows a thrown onSendTimeout hook so the queue keeps draining", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 15,
        onSendTimeout: () => {
          throw new Error("hook-broken");
        },
      });
      const hung = limiter.enqueue(cancelOnAbort);
      const after = limiter.enqueue(() => Promise.resolve());
      expect(await captureRejection(hung)).toMatchObject({ code: "TIMEOUT" });
      await after;
    });
  });
});
