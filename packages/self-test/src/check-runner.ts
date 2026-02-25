/**
 * Check execution helper — wraps individual checks with timeout and error containment.
 */

import type { EngineAdapter, EngineEvent, KoiError } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { CheckCategory, CheckResult } from "./types.js";

/** Type guard: adapter config is a factory function (vs an instance). */
export function isAdapterFactory(
  value: EngineAdapter | (() => EngineAdapter | Promise<EngineAdapter>),
): value is () => EngineAdapter | Promise<EngineAdapter> {
  return typeof value === "function";
}

/**
 * Run a single check with timeout and error containment.
 *
 * The check function receives an AbortSignal that fires on timeout.
 * Checks that complete normally produce a "pass" result.
 * Checks that throw (or time out) produce a "fail" result.
 * Never throws — all errors are captured into CheckResult.
 */
export async function runCheck(
  name: string,
  category: CheckCategory,
  fn: (signal: AbortSignal) => void | Promise<void>,
  timeoutMs: number,
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    // Race the check against the timeout — if fn ignores the signal and never
    // resolves, the timeout promise rejects and Promise.race propagates it.
    const timeoutRejection = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    await Promise.race([fn(signal), timeoutRejection]);
    return {
      name,
      category,
      status: "pass",
      durationMs: Date.now() - start,
    };
  } catch (e: unknown) {
    const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
    const error: KoiError = {
      code: isTimeout ? "TIMEOUT" : "INTERNAL",
      message: isTimeout
        ? `Check "${name}" timed out after ${String(timeoutMs)}ms`
        : e instanceof Error
          ? e.message
          : String(e),
      retryable: isTimeout ? RETRYABLE_DEFAULTS.TIMEOUT : RETRYABLE_DEFAULTS.INTERNAL,
      ...(e instanceof Error && e.cause !== undefined ? { cause: e.cause } : {}),
    };
    return {
      name,
      category,
      status: "fail",
      durationMs: Date.now() - start,
      error,
      message: error.message,
    };
  }
}

/** Collect all events from an async iterable into an array. */
export async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  // Local mutable array for accumulation — not shared state
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** Extract concatenated text from text_delta events. */
export function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

/** Create a skip check result. */
export function skipCheck(name: string, category: CheckCategory, message: string): CheckResult {
  return { name, category, status: "skip", durationMs: 0, message };
}
