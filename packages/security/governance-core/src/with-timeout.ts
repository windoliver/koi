/**
 * ApprovalTimeoutError — sentinel thrown by `withTimeout` when the timer
 * fires before the inner promise settles. Callers distinguish via
 * `isApprovalTimeout` to map to `KoiRuntimeError({ code: "TIMEOUT" })`.
 */
export class ApprovalTimeoutError extends Error {
  override readonly name = "ApprovalTimeoutError";
}

export function isApprovalTimeout(e: unknown): e is ApprovalTimeoutError {
  return e instanceof ApprovalTimeoutError;
}

/**
 * Race a promise against a timeout and an optional abort signal.
 * Clears the timer on settlement to avoid leaking handles.
 *
 * - Resolves with the promise value when it settles first.
 * - Rejects with `ApprovalTimeoutError` when the timer fires first.
 * - Rejects with a `DOMException("AbortError")` when the abort signal fires
 *   (or is already aborted).
 */
export function withTimeout<T>(p: Promise<T>, ms: number, abortSignal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortListener !== undefined && abortSignal !== undefined) {
        abortSignal.removeEventListener("abort", abortListener);
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new ApprovalTimeoutError(`Approval timed out after ${ms}ms`)));
    }, ms);

    let abortListener: (() => void) | undefined;
    if (abortSignal !== undefined) {
      if (abortSignal.aborted) {
        finish(() => reject(new DOMException("Aborted", "AbortError")));
        return;
      }
      abortListener = (): void => {
        finish(() => reject(new DOMException("Aborted", "AbortError")));
      };
      abortSignal.addEventListener("abort", abortListener, { once: true });
    }

    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}
