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
 * Send callback. Receives an `AbortSignal` that is fired when the queue's
 * watchdog deadline (`sendTimeoutMs`) elapses.
 *
 * Default mode (strict FIFO + single-flight): the caller is rejected with
 * a `TIMEOUT` `KoiError` at the deadline, but the queue does NOT advance
 * until the underlying promise settles. This guarantees at-most-one
 * in-flight send. Cost: a transport that ignores `signal.aborted` can hold
 * the queue indefinitely. Adapters MUST honor abort to keep the queue
 * live.
 *
 * Liveness mode (`advanceOnTimeout: true`): queue advances on timeout
 * regardless of the underlying promise's state. Late settlement surfaces
 * through `onLateSuccess` / `onLateFailure`. Use only when the transport
 * provides wire-level idempotency (message IDs, dedupe keys); otherwise
 * a late-resolving send can produce duplicate user-visible output.
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
    // Drain-facing: settles when the underlying send finishes OR after a
    // grace backstop that starts AT THE DEADLINE (so total stall is bounded
    // at 2× sendTimeoutMs even when the transport ignores abort). Until the
    // deadline we just wait on fnPromise — the grace only matters for the
    // abort-ignored window.
    const settled = new Promise<void>((resolveSettled) => {
      // let justified: race winner across fnPromise / grace timer
      let done = false;
      // let justified: armed only after the deadline fires
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        resolveSettled();
      };
      fnPromise.then(finish, finish);
      // Arm the grace backstop only when the watchdog actually fires.
      // Wait for the result promise to reject, then start the grace timer.
      result.catch(() => {
        if (!timedOut || done) return;
        graceTimer = setTimeout(finish, sendTimeoutMs);
      });
    });
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

            // For deadline-exceeded TIMEOUTs (synthetic watchdog rejection,
            // not a transport-reported TIMEOUT), the caller-facing error
            // and the retry decision must reflect the underlying send's
            // REAL outcome, not the synthetic timeout. Otherwise an
            // idempotent-retry config could re-issue a send that actually
            // succeeded late, or replay after a definitive terminal error
            // like PERMISSION; or the caller could see TIMEOUT for a send
            // that the transport reported a structured error for.
            // let justified: mutable so we can re-classify on late outcome
            let classifyError: unknown = error;
            if (
              isKoiError(error) &&
              error.code === "TIMEOUT" &&
              (error.context as { phase?: string } | undefined)?.phase === "deadline-exceeded"
            ) {
              await run.settled;
              const late = run.lateOutcome();
              if (late.kind === "success") {
                // Underlying send succeeded after the deadline. Treat the
                // entry as resolved and skip the retry path entirely.
                lastError = undefined;
                break;
              }
              if (late.kind === "failure" && isKoiError(late.error)) {
                // Real structured terminal error arrived after the
                // deadline. Use it for retry classification and the
                // caller-facing rejection. We require KoiError because
                // an abort-honoring transport typically rejects with a
                // generic abort error that is indistinguishable from a
                // transport hiccup; only structured KoiError responses
                // represent a real terminal classification.
                classifyError = late.error;
                lastError = late.error;
              }
              // late.kind === "abort-ignored": grace expired without a
              // real outcome. Keep the synthetic TIMEOUT.
            }

            // Skip retry analysis when no retries remain.
            if (attempt >= retryConfig.maxRetries) break;

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
            // Always wait for the previous attempt to settle before
            // reissuing the same send fn — even in liveness mode. The
            // `advanceOnTimeout` knob governs only when the queue
            // advances to the NEXT entry; retrying the SAME entry must
            // never start a fresh invocation while the previous one is
            // still running, or we could fan two concurrent invocations
            // of a non-idempotent send onto the same transport.
            await run.settled;
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

        // Caller is signaled immediately; the queue's advance is gated
        // separately by the per-attempt settle promise. In default
        // (strict-FIFO) mode we await the most recent settle so the next
        // entry never overlaps with a still-running send. In liveness mode
        // we skip the wait — the grace backstop inside runWithDeadline
        // already caps how long settle can stall.
        if (lastError !== undefined) {
          entry.reject(lastError);
        } else {
          entry.resolve();
        }
        if (!advanceOnTimeout && lastSettled !== undefined) {
          await lastSettled;
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
