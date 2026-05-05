/**
 * Per-attempt timeout / abort guard. Runs a caller-supplied async
 * callback against a deadline and an `AbortController`, ensuring the
 * synthesis loop never overlaps adapter side effects across retries
 * in strict mode and never hangs on a stuck adapter in best-effort
 * mode.
 */

import type { SynthesisFailureKind } from "./types.js";

export type GuardedResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly aborted?: boolean;
      /**
       * `true` when `reason` contains caller-controlled text (a thrown error's
       * message, or text returned by the verifier callback). The synthesis
       * loop must run such reasons through `sanitizeVerifierReason` before
       * exposing them — both on the public `SynthesisResult.reason` channel
       * (which higher layers may log/persist) and the LLM retry prompt.
       * Internal-only reasons (`timed out`, `aborted by caller`, etc.)
       * leave this `undefined`/false and are forwarded as-is.
       */
      readonly tainted?: boolean;
      /**
       * Coarse failure category set by the wrapper that produced this
       * result (safeGenerate / safeVerify) and surfaced as
       * `SynthesisResult.kind`. Independent of `reason` text so callers
       * can branch on it even after sanitization redacts the human
       * message. `guardAttempt` itself does not set this — callers know
       * which side of the synthesis pipeline they wrap.
       */
      readonly failureKind?: SynthesisFailureKind;
    };

/**
 * Wire an external `signal` to a per-attempt `AbortController` so that
 * timeout, parent-cancel, or outer-loop completion all abort the same
 * controller — and the callbacks see one cancellation event regardless
 * of which side fired. Returns a detach function the caller invokes when
 * the attempt resolves successfully (avoids dangling listeners).
 */
export function linkSignal(
  external: AbortSignal | undefined,
  attempt: AbortController,
): () => void {
  if (!external) return () => undefined;
  if (external.aborted) {
    attempt.abort();
    return () => undefined;
  }
  const onAbort = (): void => attempt.abort();
  external.addEventListener("abort", onAbort, { once: true });
  return () => external.removeEventListener("abort", onAbort);
}

/**
 * Run a caller-supplied sanitizer without letting a buggy implementation
 * propagate exceptions or return non-string values past the trust
 * boundary. Failure here means we fall back to a fixed generic string
 * rather than forwarding the raw verifier reason.
 */
export function safeSanitize(sanitize: (reason: string) => string, reason: string): string {
  try {
    const out = sanitize(reason);
    if (typeof out !== "string") return "failure reason omitted";
    return out;
  } catch {
    return "failure reason omitted";
  }
}

/**
 * Defense-in-depth pass over a sanitized failure reason: strip control
 * characters and cap length so a single verbose failure can't blow out
 * the next prompt's token budget or smuggle terminal escapes through.
 */
export function redactReason(reason: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping is the point
  const cleaned = reason.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
  const MAX = 240;
  if (cleaned.length <= MAX) return cleaned;
  return `${cleaned.slice(0, MAX)}… [truncated ${cleaned.length - MAX} chars]`;
}

/**
 * Race a callback against a timeout and the per-attempt `AbortController`.
 * On timeout, the controller is aborted so a well-behaved callback can
 * stop its work and the loop never starts a new attempt while the prior
 * one runs.
 *
 * `aborted: true` on the failure variant tells the loop to stop iterating;
 * timeouts return `aborted: undefined` so the loop continues to the next
 * attempt up to `maxAttempts`.
 *
 * `blockUntilUnwind === true` (strict mode): wait indefinitely for the
 * in-flight callback to actually unwind after timeout/abort fires. Costs
 * the wall-clock end-to-end cap (a slow adapter extends the attempt) but
 * guarantees retry attempt N+1 NEVER runs while attempt N is still
 * executing.
 *
 * `blockUntilUnwind === false` (best-effort mode): settle after a bounded
 * `graceMs` so a fully-hung callback cannot pin synthesize() forever. The
 * caller has already accepted that abandoned callbacks may keep running.
 */
export function guardAttempt<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  attempt: AbortController,
  label: string,
  blockUntilUnwind: boolean,
): Promise<GuardedResult<T>> {
  return new Promise<GuardedResult<T>>((resolve) => {
    let settled = false;
    // Once timeout or external abort latches a chosen failure, late
    // success/error from the callback MUST NOT override it.
    let cancelled = false;
    let runPromise: Promise<unknown> = Promise.resolve();
    const finish = (result: GuardedResult<T>): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      attempt.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    // Grace window bounded so attemptTimeoutMs is the true end-to-end
    // cap in best-effort mode. Strict mode replaces this with an
    // unbounded wait on the run promise.
    const graceMs = Number.isFinite(timeoutMs) ? Math.min(1000, Math.floor(timeoutMs * 0.5)) : 1000;
    const settleAfterUnwind = (result: GuardedResult<T>): void => {
      cancelled = true;
      let done = false;
      const finishOnce = (): void => {
        if (done) return;
        done = true;
        finish(result);
      };
      const graceTimer = blockUntilUnwind ? null : setTimeout(finishOnce, graceMs);
      const cancelGrace = (): void => {
        if (graceTimer !== null) clearTimeout(graceTimer);
      };
      runPromise.then(
        () => {
          cancelGrace();
          finishOnce();
        },
        () => {
          cancelGrace();
          finishOnce();
        },
      );
    };

    // Fail closed when the budget is already exhausted. setTimeout(fn, 0)
    // would queue the timer behind the microtask that resolves run()'s
    // promise, so a stage entered with no budget left could still execute
    // and even succeed before the timer fires.
    if (Number.isFinite(timeoutMs) && timeoutMs <= 0) {
      attempt.abort();
      resolve({ ok: false, reason: `${label} timed out after 0ms` });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        timedOut = true;
        attempt.abort();
        settleAfterUnwind({ ok: false, reason: `${label} timed out after ${timeoutMs}ms` });
      }, timeoutMs);
    }

    const onAbort = (): void => {
      if (timedOut) return;
      settleAfterUnwind({ ok: false, reason: `${label} aborted by caller`, aborted: true });
    };
    if (attempt.signal.aborted) {
      onAbort();
      return;
    }
    attempt.signal.addEventListener("abort", onAbort, { once: true });

    try {
      runPromise = run(attempt.signal);
      runPromise.then(
        (value) => {
          if (cancelled) return; // timeout/abort already chose the result
          finish({ ok: true, value: value as T });
        },
        (err: unknown) => {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : String(err);
          finish({ ok: false, reason: `${label} failed: ${message}`, tainted: true });
        },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      finish({ ok: false, reason: `${label} failed: ${message}`, tainted: true });
    }
  });
}
