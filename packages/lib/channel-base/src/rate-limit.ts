/**
 * Rate-limit-aware send queue for channel adapters.
 *
 * Sequential FIFO queue. Pauses on rate-limit errors and retries with
 * exponential backoff. The default policy is intentionally narrower than
 * `@koi/errors.isRetryable()`: it auto-retries only the transport-class
 * codes RATE_LIMIT (server-acknowledged throttling), because state-gated codes such
 * as AUTH_REQUIRED and RESOURCE_EXHAUSTED are recoverable only after
 * external intervention and must not be re-issued in a tight loop.
 *
 * Callers with domain knowledge can broaden retry semantics through the
 * `extractRetryAfterMs` and `isRetryable` config hooks; either hook
 * returning a defined retry signal opts the error into retry. Non-KoiError
 * exceptions reject immediately by default so non-idempotent sends are
 * never re-issued.
 */

import type { KoiError, KoiErrorCode } from "@koi/core";
import {
  computeBackoff,
  DEFAULT_RETRY_CONFIG,
  isKoiError,
  type RetryConfig,
  sleep,
} from "@koi/errors";

export interface RateLimiterConfig {
  /** Retry configuration for rate-limited sends. */
  readonly retry?: RetryConfig;
  /**
   * Extracts a retry-after delay (in ms) from a caught error. Returning a
   * defined value both schedules the next attempt's delay AND classifies
   * the error as retryable — caller-supplied extractors are trusted because
   * they encode adapter-specific knowledge.
   *
   * The built-in default returns `error.retryAfterMs` only when the error
   * is a `KoiError` whose code is in the transport-retry allowlist
   * (RATE_LIMIT, TIMEOUT). State-gated codes like AUTH_REQUIRED
   * intentionally produce undefined even if they carry `retryAfterMs`, so
   * the queue does not auto-retry them.
   */
  readonly extractRetryAfterMs?: (error: unknown) => number | undefined;
  /**
   * Decides whether an error should be retried independent of any retry-after
   * hint. Defaults to a narrow transport allowlist: `KoiError` with code in
   * { RATE_LIMIT }. Pass a custom predicate (e.g.
   * `(e) => isKoiError(e) && isKoiRetryable(e)`) to broaden the policy.
   */
  readonly isRetryable?: (error: unknown) => boolean;
  /**
   * Called when the retry machinery itself fails — a thrown classifier,
   * malformed `computeBackoff` config, or rejected `sleep`. The default
   * `swallow` behavior preserves queue progress, but operators that want
   * a diagnostic breadcrumb can supply this hook to surface the broken
   * retry path. Hook errors are themselves swallowed.
   */
  readonly onInternalError?: (
    stage: "extract" | "classify" | "backoff" | "sleep",
    error: unknown,
  ) => void;
  /**
   * Maximum time to wait for a single `entry.fn()` invocation before
   * treating it as wedged. A hung provider call would otherwise block the
   * strict-FIFO queue indefinitely and silently drop every later send.
   * When the deadline elapses, the in-flight entry is rejected with a
   * `KoiError` of code `TIMEOUT` and the drain loop advances. Defaults to
   * 30s. Pass `0` or `Infinity` to opt out (e.g. for transports that
   * already enforce their own timeout).
   */
  readonly sendTimeoutMs?: number;
  /**
   * Called once per send attempt that exceeds `sendTimeoutMs`. Operators
   * use this to detect a wedged channel — a quiet queue with no completed
   * sends is otherwise indistinguishable from no traffic.
   */
  readonly onSendTimeout?: () => void;
  /**
   * Called when a previously-timed-out send finally resolves. The caller
   * already received a `TIMEOUT` rejection, so this is a telemetry-only
   * signal: it tells operators the message was likely delivered after the
   * deadline. Only fires when `advanceOnTimeout` is enabled (strict-FIFO
   * mode awaits the underlying promise inline before advancing).
   */
  readonly onLateSuccess?: () => void;
  /**
   * Called when a previously-timed-out send eventually rejects. Telemetry
   * only — the caller already saw a `TIMEOUT`. Only fires when
   * `advanceOnTimeout` is enabled.
   */
  readonly onLateFailure?: (error: unknown) => void;
  /**
   * Default `false` (strict FIFO + single-flight): on timeout, the queue
   * waits for the underlying send to actually settle before advancing.
   * This preserves the rate limiter's core invariant — at most one send
   * is in flight at a time — at the cost of liveness when a transport
   * ignores `AbortSignal` indefinitely.
   *
   * Set `true` only for transports that enforce idempotency at the wire
   * level (provider-side message IDs, dedupe keys). Liveness mode advances
   * the queue immediately on timeout and observes late settlement through
   * `onLateSuccess` / `onLateFailure`. WARNING: enabling this without
   * transport-level dedupe can produce duplicate user-visible output if a
   * timed-out send eventually succeeds.
   */
  readonly advanceOnTimeout?: boolean;
}

const DEFAULT_SEND_TIMEOUT_MS = 30_000;

/**
 * Send callback. Receives an `AbortSignal` that fires when the queue's
 * watchdog deadline (`sendTimeoutMs`) elapses.
 *
 * The caller-facing `enqueue()` promise rejects at the deadline on the
 * final attempt (no retries remaining). For attempts that may retry,
 * `enqueue()` may settle later — the loop waits for the underlying send
 * to actually finish so the retry decision can use the real outcome
 * instead of the synthetic deadline TIMEOUT.
 *
 * Default mode (strict FIFO + single-flight): the queue NEVER advances or
 * retries while the underlying promise is still pending. This guarantees
 * at-most-one in-flight send and FIFO delivery for any transport that
 * honors `signal.aborted`. A transport that ignores abort will hold the
 * queue indefinitely — that is the documented cost of strict mode and
 * the reason adapters MUST honor abort.
 *
 * Liveness mode (`advanceOnTimeout: true`): queue advance and retries
 * are bounded by an extra grace window of `sendTimeoutMs`. Late
 * settlement still surfaces through `onLateSuccess` / `onLateFailure`.
 * Single-flight is best-effort — abort-ignoring transports can produce
 * overlapping sends, so use this only with wire-level idempotency
 * (message IDs, dedupe keys).
 */
export type SendFn = (signal: AbortSignal) => Promise<void>;

export interface RateLimiter {
  /** Enqueues a send. Resolves when the send completes (after any retries). */
  readonly enqueue: (fn: SendFn) => Promise<void>;
  /** Number of items waiting in the queue (excludes the in-flight item). */
  readonly size: () => number;
}

interface QueueEntry {
  readonly fn: SendFn;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Codes that are safe to auto-retry inline within a single send queue.
 * The default policy is intentionally the narrowest possible set: only
 * server-acknowledged throttling, where the remote side has explicitly
 * told us the request was rejected and asked us to wait.
 *
 * Deliberately excluded:
 *   - TIMEOUT            → request status is unknown; the remote may have
 *                          accepted the message before the local timeout
 *                          fired, so retrying a non-idempotent send risks
 *                          duplicate user-visible output. Adapters with
 *                          provider-side dedupe (idempotency keys, message
 *                          IDs) opt in via a custom `isRetryable`.
 *   - CONFLICT           → typically a CAS / already-exists mismatch; replaying
 *                          a partially-successful send could duplicate output.
 *   - AUTH_REQUIRED      → recoverable only after the user completes OAuth.
 *   - RESOURCE_EXHAUSTED → recoverable only after capacity is freed; tight retry would just thrash.
 *   - PERMISSION / VALIDATION / NOT_FOUND / STALE_REF / INTERNAL / UNAVAILABLE / HEARTBEAT_TIMEOUT
 *                        → either permanent or require operator action.
 *   - EXTERNAL           → defaults to retryable=false in RETRYABLE_DEFAULTS; opt-in via callback.
 */
const TRANSPORT_RETRY_CODES: ReadonlySet<KoiErrorCode> = new Set<KoiErrorCode>(["RATE_LIMIT"]);

/** Returns the retry-after hint only when it is a finite, non-negative number. */
const sanitizeRetryAfterMs = (raw: unknown): number | undefined => {
  if (typeof raw !== "number") return undefined;
  if (!Number.isFinite(raw) || raw < 0) return undefined;
  return raw;
};

const defaultExtractRetryAfterMs = (error: unknown): number | undefined => {
  if (!isKoiError(error)) return undefined;
  if (!TRANSPORT_RETRY_CODES.has(error.code)) return undefined;
  return sanitizeRetryAfterMs(error.retryAfterMs);
};

const defaultIsRetryable = (error: unknown): boolean =>
  isKoiError(error) && TRANSPORT_RETRY_CODES.has(error.code);

export function createRateLimiter(config?: RateLimiterConfig): RateLimiter {
  const retryConfig = config?.retry ?? DEFAULT_RETRY_CONFIG;
  // Fail fast on invalid retry config: a negative maxRetries (e.g. from a
  // bad env/JSON parse) would skip the for-loop entirely, causing every
  // enqueue() to resolve as success without ever invoking the transport.
  // That is silent data loss on the send path.
  if (!Number.isInteger(retryConfig.maxRetries) || retryConfig.maxRetries < 0) {
    throw new Error(
      `RateLimiterConfig.retry.maxRetries must be a non-negative integer, got ${String(
        retryConfig.maxRetries,
      )}`,
    );
  }
  const extractRetryAfterMs = config?.extractRetryAfterMs ?? defaultExtractRetryAfterMs;
  const isRetryable = config?.isRetryable ?? defaultIsRetryable;
  const sendTimeoutMs = config?.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  // Only the documented opt-out values (0 or Infinity) disable the
  // watchdog. NaN, negative numbers, or other malformed inputs would
  // otherwise silently fall through to the passthrough path and let a
  // hung provider wedge the queue forever — exactly the failure mode this
  // feature exists to prevent.
  if (typeof sendTimeoutMs !== "number" || Number.isNaN(sendTimeoutMs) || sendTimeoutMs < 0) {
    throw new Error(
      `RateLimiterConfig.sendTimeoutMs must be a non-negative number (or Infinity to opt out), got ${String(
        sendTimeoutMs,
      )}`,
    );
  }
  const sendTimeoutEnabled = Number.isFinite(sendTimeoutMs) && sendTimeoutMs > 0;
  const advanceOnTimeout = config?.advanceOnTimeout ?? false;

  // let justified: mutable queue state, immutable swap on each mutation
  let queue: readonly QueueEntry[] = [];
  // let justified: re-entrancy guard for the drain loop
  let processing = false;

  const reportInternal = (
    stage: "extract" | "classify" | "backoff" | "sleep",
    error: unknown,
  ): void => {
    if (config?.onInternalError === undefined) return;
    try {
      config.onInternalError(stage, error);
    } catch {
      // Hook itself misbehaved — swallow so the queue keeps draining.
    }
  };

  // Wrap classifier hooks so a thrown user callback never wedges the queue —
  // we treat a thrown classifier as "not retryable" and reject the entry below.
  const safeExtract = (error: unknown): number | undefined => {
    try {
      return extractRetryAfterMs(error);
    } catch (hookError) {
      reportInternal("extract", hookError);
      return undefined;
    }
  };
  const safeIsRetryable = (error: unknown): boolean => {
    try {
      return isRetryable(error);
    } catch (hookError) {
      reportInternal("classify", hookError);
      return false;
    }
  };

  // Runs `fn(signal)` and returns two promises with independent contracts:
  //
  //   `result`  — caller-facing. Settles no later than `sendTimeoutMs`.
  //               Resolves on send success, rejects on send failure, or
  //               rejects with TIMEOUT KoiError when the watchdog fires.
  //
  //   `settled` — drain-loop-facing. Resolves when the underlying send
  //               actually settles, OR after the abort-grace backstop
  //               (`sendTimeoutMs` again) — whichever comes first. The
  //               drain loop awaits this in default mode to preserve
  //               single-flight; in `advanceOnTimeout` mode it ignores it.
  //
  // The grace backstop is critical: it prevents an abort-ignoring transport
  // from holding the queue forever. After `sendTimeoutMs` past the deadline
  // (so 2× total), the drain loop advances regardless, accepting that the
  // send is permanently indeterminate. Compliant transports settle far
  // faster than the grace and preserve strict FIFO.
  //
  // Disabled deadline (0 / Infinity): transparent passthrough.
  type LateOutcome =
    | { readonly kind: "success" }
    | { readonly kind: "failure"; readonly error: unknown }
    | { readonly kind: "abort-ignored" };
  interface DeadlineRun {
    readonly result: Promise<void>;
    readonly settled: Promise<void>;
    /**
     * Returns the underlying send's actual outcome after `settled`
     * resolves. `abort-ignored` means the grace backstop fired before
     * the transport settled — delivery status is permanently unknown.
     * Used by the retry loop to classify on the real terminal outcome
     * instead of the synthetic deadline TIMEOUT.
     */
    readonly lateOutcome: () => LateOutcome;
  }
  // Wraps fn(signal) so a synchronous throw becomes a rejected promise —
  // otherwise the throw escapes runWithDeadline before any catch path is
  // armed, orphaning the queue entry's caller forever.
  const invoke = (fn: SendFn, signal: AbortSignal): Promise<void> => {
    try {
      return fn(signal);
    } catch (syncErr) {
      return Promise.reject(syncErr);
    }
  };
  const runWithDeadline = (fn: SendFn): DeadlineRun => {
    if (!sendTimeoutEnabled) {
      const passthrough = new AbortController();
      const fnPromise = invoke(fn, passthrough.signal);
      // let justified: captured by lateOutcome accessor
      let outcome: LateOutcome = { kind: "abort-ignored" };
      fnPromise.then(
        () => {
          outcome = { kind: "success" };
        },
        (err) => {
          outcome = { kind: "failure", error: err };
        },
      );
      return {
        result: fnPromise,
        settled: fnPromise.catch(() => {}),
        lateOutcome: () => outcome,
      };
    }
    const controller = new AbortController();
    const fnPromise = invoke(fn, controller.signal);
    // let justified: tracks whether the watchdog fired
    let timedOut = false;
    // let justified: captured by lateOutcome accessor; defaults to
    // abort-ignored if grace expires before fnPromise settles
    let outcome: LateOutcome = { kind: "abort-ignored" };
    // Caller-facing: bounded by sendTimeoutMs.
    const result = new Promise<void>((resolve, reject) => {
      // let justified: race winner
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        timedOut = true;
        controller.abort();
        try {
          config?.onSendTimeout?.();
        } catch {
          // observer hook misbehaved — keep the queue moving
        }
        // `context.phase: "deadline-exceeded"` tells callers this is the
        // local watchdog firing (delivery status unknown) rather than a
        // transport-reported TIMEOUT response. The eventual real outcome
        // — late success or late terminal error — surfaces through the
        // `onLateSuccess` / `onLateFailure` telemetry hooks. Adapters
        // that need the actual classification (e.g. converting a late
        // PERMISSION into a non-retry) should subscribe to those.
        const timeoutError: KoiError = {
          code: "TIMEOUT",
          message: `channel send did not settle within ${sendTimeoutMs}ms`,
          retryable: false,
          context: { phase: "deadline-exceeded" },
        };
        reject(timeoutError);
      }, sendTimeoutMs);
      fnPromise.then(
        (value) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    });
    // Capture the real terminal outcome and emit telemetry whenever the
    // underlying send eventually settles. Hook errors are swallowed.
    fnPromise.then(
      () => {
        outcome = { kind: "success" };
        if (!timedOut) return;
        try {
          config?.onLateSuccess?.();
        } catch {
          // telemetry hook misbehaved — non-fatal
        }
      },
      (lateErr) => {
        outcome = { kind: "failure", error: lateErr };
        if (!timedOut) return;
        try {
          config?.onLateFailure?.(lateErr);
        } catch {
          // telemetry hook misbehaved — non-fatal
        }
      },
    );
    // Drain-facing: settles ONLY when the underlying send actually
    // resolves or rejects. No grace surrogate — the drain loop in
    // strict-FIFO mode (advanceOnTimeout: false) needs this to truly
    // mean "in-flight is over" so it can guarantee single-flight and
    // FIFO. Grace-based liveness lives in the drain loop (gated on the
    // `advanceOnTimeout` flag), not in this primitive.
    const settled = fnPromise.then(
      () => {},
      () => {},
    );
    return { result, settled, lateOutcome: () => outcome };
  };

  const drain = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const [entry, ...rest] = queue;
        queue = rest;
        if (entry === undefined) continue;

        // let justified: tracks the last error across retry attempts
        let lastError: unknown;
        // let justified: feeds decorrelated jitter so the window widens
        let prevDelayMs: number | undefined;
        // let justified: collects per-attempt settle promises for FIFO
        let lastSettled: Promise<void> | undefined;
        for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
          const run = runWithDeadline(entry.fn);
          lastSettled = run.settled;
          try {
            await run.result;
            lastError = undefined;
            break;
          } catch (error: unknown) {
            lastError = error;

            const isDeadlineTimeout =
              isKoiError(error) &&
              error.code === "TIMEOUT" &&
              (error.context as { phase?: string } | undefined)?.phase === "deadline-exceeded";

            // On the final attempt with no retries remaining: in strict
            // mode the queue is already going to wait for the underlying
            // send to settle (single-flight gate on advance), so we have
            // a free opportunity to upgrade the caller's outcome from
            // the synthetic TIMEOUT to the real terminal result. This
            // avoids the duplicate-send hazard where upstream code
            // retries a send that actually completed. In liveness mode
            // we don't wait — caller sees prompt synthetic TIMEOUT; the
            // real outcome surfaces via onLateSuccess/onLateFailure.
            if (attempt >= retryConfig.maxRetries) {
              if (isDeadlineTimeout && !advanceOnTimeout) {
                // Best-effort upgrade: bound the wait at sendTimeoutMs so
                // an abort-ignoring transport cannot hang the caller. If
                // the real outcome lands inside the grace window, surface
                // it; otherwise the caller sees the synthetic TIMEOUT
                // and the late outcome flows to onLateSuccess/onLateFailure.
                await Promise.race([
                  run.settled,
                  new Promise<void>((res) => setTimeout(res, sendTimeoutMs)),
                ]);
                const late = run.lateOutcome();
                if (late.kind === "success") {
                  lastError = undefined;
                } else if (late.kind === "failure") {
                  lastError = late.error;
                }
                // late.kind === "abort-ignored": keep synthetic TIMEOUT.
              }
              break;
            }

            // For deadline-exceeded TIMEOUTs (synthetic watchdog rejection,
            // not a transport-reported TIMEOUT), the retry decision must
            // be based on the underlying send's REAL outcome, not the
            // synthetic timeout. Wait for fnPromise to actually settle
            // before classifying, so:
            //   - a late success skips the retry (entry succeeded);
            //   - a late terminal error replaces the synthetic TIMEOUT
            //     for retry classification and caller-facing rejection;
            //   - retries gate on real settlement, never overlapping
            //     with a still-running attempt.
            // In strict-FIFO mode this also doubles as the queue's
            // single-flight gate. With an abort-ignoring transport this
            // wait is unbounded — that's the documented price of strict
            // mode; users who need liveness must opt into
            // `advanceOnTimeout: true`.
            // let justified: mutable so we can re-classify on late outcome
            let classifyError: unknown = error;
            if (
              isKoiError(error) &&
              error.code === "TIMEOUT" &&
              (error.context as { phase?: string } | undefined)?.phase === "deadline-exceeded"
            ) {
              if (advanceOnTimeout) {
                // Liveness: bound the late-outcome wait so an
                // abort-ignoring transport cannot delay retries forever.
                // After the grace, classify on the synthetic TIMEOUT.
                await Promise.race([
                  run.settled,
                  new Promise<void>((res) => setTimeout(res, sendTimeoutMs)),
                ]);
              } else {
                // Strict mode: wait for real settlement so retries within
                // the same entry never overlap. Final-attempt path
                // bounds this wait separately to keep callers responsive.
                await run.settled;
              }
              const late = run.lateOutcome();
              if (late.kind === "success") {
                lastError = undefined;
                break;
              }
              if (late.kind === "failure") {
                classifyError = late.error;
                lastError = late.error;
              }
              // late.kind === "abort-ignored": no real outcome yet.
              // Keep the synthetic TIMEOUT for classification.
            }

            // A defined retry-after hint OR a positive isRetryable verdict
            // opts the error into a retry. The default extractor already
            // refuses to emit a hint for state-gated codes, so this OR is
            // safe; callers who provide a custom extractor are trusted to
            // know what their hint means.
            const retryAfterMs = sanitizeRetryAfterMs(safeExtract(classifyError));
            const retryable = retryAfterMs !== undefined || safeIsRetryable(classifyError);
            if (!retryable) break;

            // Route through computeBackoff so the provider hint is clamped to
            // maxBackoffMs and falls back to backoff when the hint is absent.
            // Pass prevDelay so decorrelated jitter widens correctly across
            // retries instead of collapsing to the base delay each time.
            // computeBackoff is pure but its config can technically throw if a
            // caller plugs in a malformed RNG — treat that as terminal failure
            // rather than wedging the queue.
            // let justified: mutable to preserve final delay across try/catch
            let delay: number;
            try {
              delay = computeBackoff(attempt, retryConfig, retryAfterMs, undefined, prevDelayMs);
            } catch (backoffError) {
              reportInternal("backoff", backoffError);
              break;
            }
            prevDelayMs = delay;
            // Wait for the previous attempt's underlying send to settle
            // before reissuing. In strict mode this is unbounded (price
            // of single-flight); in liveness mode the late-outcome
            // resolution above already bounded the wait at sendTimeoutMs,
            // so settled is either resolved (real outcome) or unbounded
            // again — cap it here for liveness too.
            if (advanceOnTimeout) {
              await Promise.race([
                run.settled,
                new Promise<void>((res) => setTimeout(res, sendTimeoutMs)),
              ]);
            } else {
              await run.settled;
            }
            // Re-check the real outcome immediately before retrying. A late
            // success that landed during the second wait must NOT be
            // followed by a duplicate send; a late terminal failure
            // overrides the synthetic TIMEOUT for caller rejection.
            {
              const lateBeforeRetry = run.lateOutcome();
              if (lateBeforeRetry.kind === "success") {
                lastError = undefined;
                break;
              }
              if (lateBeforeRetry.kind === "failure") {
                lastError = lateBeforeRetry.error;
                // Reclassify against the real failure: if non-retryable,
                // stop here instead of reissuing.
                const lateRetryAfter = sanitizeRetryAfterMs(safeExtract(lateBeforeRetry.error));
                const lateRetryable =
                  lateRetryAfter !== undefined || safeIsRetryable(lateBeforeRetry.error);
                if (!lateRetryable) break;
              }
            }
            // Wrap sleep so a sleeper rejection (clock corruption, monkey-
            // patched timers, etc.) does not abandon the in-flight entry —
            // we treat it as terminal failure for this entry and resume
            // draining instead of leaving the caller hanging forever.
            try {
              await sleep(delay);
            } catch (sleepError) {
              reportInternal("sleep", sleepError);
              break;
            }
          }
        }

        // Resolve the caller first — they should not wait on the queue's
        // advance bookkeeping.
        if (lastError !== undefined) {
          entry.reject(lastError);
        } else {
          entry.resolve();
        }
        // Queue advance gate. Strict mode (default) waits for the real
        // underlying send to settle before pulling the next entry —
        // single-flight is preserved even when a transport ignores
        // abort, at the cost of liveness on bad transports. Liveness
        // mode caps the wait at the grace window so the queue cannot
        // wedge forever; users opt into this knowing single-flight
        // becomes best-effort.
        if (lastSettled !== undefined) {
          if (advanceOnTimeout) {
            await Promise.race([
              lastSettled,
              new Promise<void>((res) => setTimeout(res, sendTimeoutMs)),
            ]);
          } else {
            await lastSettled;
          }
        }
      }
    } finally {
      processing = false;
    }
  };

  return {
    enqueue: (fn: SendFn): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        queue = [...queue, { fn, resolve, reject }];
        void drain();
      }),
    size: (): number => queue.length,
  };
}
