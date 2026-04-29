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

    it("does not auto-retry TIMEOUT — request status is unknown", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 5 },
      });
      let attempts = 0;
      await expect(
        limiter.enqueue(async () => {
          attempts++;
          throw koiError({ code: "TIMEOUT", retryable: true });
        }),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(attempts).toBe(1);
      expect(sleepSpy).not.toHaveBeenCalled();
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
            throw koiError({ code: "RATE_LIMIT" });
          }),
        ).rejects.toMatchObject({ code: "RATE_LIMIT" });

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
      await expect(limiter.enqueue(() => Promise.reject(new Error("send-fail")))).rejects.toThrow(
        "send-fail",
      );
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
      await expect(limiter.enqueue(() => Promise.reject(new Error("send-fail")))).rejects.toThrow(
        "send-fail",
      );
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
      await expect(
        limiter.enqueue(() => Promise.reject(koiError({ code: "RATE_LIMIT" }))),
      ).rejects.toMatchObject({ code: "RATE_LIMIT" });
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
      await expect(limiter.enqueue(() => Promise.reject(new Error("send-fail")))).rejects.toThrow(
        "send-fail",
      );
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
    await expect(failing).rejects.toMatchObject({ code: "RATE_LIMIT" });
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
        if (signal.aborted) return reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });

    it("rejects the in-flight entry with TIMEOUT KoiError after the deadline", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 25,
      });
      const start = Date.now();
      await expect(limiter.enqueue(cancelOnAbort)).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(Date.now() - start).toBeLessThan(2_000);
    });

    it("calls onSendTimeout for each timed-out attempt", async () => {
      const onSendTimeout = mock(() => {});
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 15,
        onSendTimeout,
      });
      await expect(limiter.enqueue(cancelOnAbort)).rejects.toMatchObject({ code: "TIMEOUT" });
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
      await expect(hung).rejects.toMatchObject({ code: "TIMEOUT" });
      await after;
      expect(completed).toEqual(["ok"]);
    });

    it("default mode preserves single-flight when transport settles within grace window", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 50,
      });
      const events: string[] = [];
      // Slow-but-compliant: resolves 20ms after the deadline (well inside
      // the 50ms grace backstop). FIFO must be preserved.
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
      await expect(a).rejects.toMatchObject({ code: "TIMEOUT" });
      await b;
      expect(events).toEqual(["A-finished", "B-sent"]);
    });

    it("grace backstop unwedges the queue when a transport ignores abort forever", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 25,
      });
      // Abort-ignoring transport that never settles. Without the grace
      // backstop the queue would wedge forever.
      const ignoresAbort: SendFn = () => new Promise<void>(() => {});
      const start = Date.now();
      const a = limiter.enqueue(ignoresAbort);
      const bDelivered: string[] = [];
      const b = limiter.enqueue(async () => {
        bDelivered.push("ok");
      });
      await expect(a).rejects.toMatchObject({ code: "TIMEOUT" });
      await b;
      expect(bDelivered).toEqual(["ok"]);
      // Total stall is bounded at ~2× sendTimeoutMs (deadline + grace).
      expect(Date.now() - start).toBeLessThan(500);
    });

    it("rejects the caller promptly at the deadline regardless of underlying send", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
        sendTimeoutMs: 20,
      });
      // Transport that takes 200ms, far longer than sendTimeoutMs.
      const slow: SendFn = () => new Promise<void>((resolve) => setTimeout(resolve, 200));
      const start = Date.now();
      await expect(limiter.enqueue(slow)).rejects.toMatchObject({ code: "TIMEOUT" });
      const elapsed = Date.now() - start;
      // Caller-facing rejection fires at sendTimeoutMs, NOT at fnPromise
      // settlement. Allow some scheduler slack.
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
        await expect(a).rejects.toMatchObject({ code: "TIMEOUT" });
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
        await expect(limiter.enqueue(slowAfterAbort)).rejects.toMatchObject({ code: "TIMEOUT" });
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
        await expect(limiter.enqueue(slowReject)).rejects.toMatchObject({ code: "TIMEOUT" });
        await new Promise((res) => setTimeout(res, 80));
        expect(onLateFailure).toHaveBeenCalledTimes(1);
        expect(onLateFailure).toHaveBeenCalledWith(
          expect.objectContaining({ message: "late-boom" }),
        );
      });
    });

    it("retry waits for prior settle even in liveness mode (no overlapping invocations of the same fn)", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 1, initialDelayMs: 0 },
        sendTimeoutMs: 30,
        advanceOnTimeout: true,
        isRetryable: (e: unknown): boolean =>
          typeof e === "object" && e !== null && (e as { code?: string }).code === "TIMEOUT",
      });
      let inFlight = 0;
      let maxConcurrent = 0;
      const fn: SendFn = () =>
        new Promise<void>((resolve) => {
          inFlight++;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          // Settles 50ms after start; deadline at 30ms, grace ends 60ms after.
          setTimeout(() => {
            inFlight--;
            resolve();
          }, 50);
        });
      await expect(limiter.enqueue(fn)).rejects.toMatchObject({ code: "TIMEOUT" });
      // Even with advanceOnTimeout=true, retries of the same fn must not
      // overlap — the second attempt must wait for the first to settle.
      expect(maxConcurrent).toBe(1);
    });

    it("retry waits for prior attempt to settle before re-issuing the send (no overlap)", async () => {
      // Custom isRetryable opts TIMEOUT into retry. Without the per-attempt
      // settle gate, a TIMEOUT on attempt 1 would re-invoke the same fn while
      // attempt 1's transport is still running — duplicate send hazard.
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 1, initialDelayMs: 0 },
        sendTimeoutMs: 30,
        isRetryable: (e: unknown): boolean =>
          typeof e === "object" && e !== null && (e as { code?: string }).code === "TIMEOUT",
      });
      // let justified: tracks concurrent in-flight invocations
      let inFlight = 0;
      let maxConcurrent = 0;
      const fn: SendFn = () =>
        new Promise<void>((resolve) => {
          inFlight++;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          // Slow but settles within grace (30ms grace, settles at 50ms after start).
          setTimeout(() => {
            inFlight--;
            resolve();
          }, 50);
        });
      // Final attempt will succeed (timeout fires first time, but before retry
      // we await settled; second attempt starts AFTER first promise resolved).
      await expect(limiter.enqueue(fn)).rejects.toMatchObject({ code: "TIMEOUT" });
      // Strict mode forbids overlapping invocations of the same send.
      expect(maxConcurrent).toBe(1);
    });

    it("synchronous throws in the send callback reject the caller and unblock the queue", async () => {
      const limiter = createRateLimiter({
        retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
      });
      const syncBoom: SendFn = () => {
        throw new Error("sync-boom");
      };
      // Caller must reject promptly, not hang forever.
      await expect(limiter.enqueue(syncBoom)).rejects.toThrow("sync-boom");
      // Queue must keep draining: a subsequent normal send completes.
      const completed: string[] = [];
      await limiter.enqueue(async () => {
        completed.push("ok");
      });
      expect(completed).toEqual(["ok"]);
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
      await expect(hung).rejects.toMatchObject({ code: "TIMEOUT" });
      await after;
    });
  });
});
