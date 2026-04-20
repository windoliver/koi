/**
 * Playwright → KoiError translator.
 *
 * Maps raw Playwright exceptions to typed KoiError objects with
 * actionable guidance for LLM agents. Uses name/message checks
 * since Playwright's TypeScript types don't export error classes.
 *
 * ## 9-pattern taxonomy
 *
 * | Pattern                        | Code        | Guidance                                    |
 * |-------------------------------|-------------|---------------------------------------------|
 * | TimeoutError (name check)     | TIMEOUT     | Try browser_wait or re-snapshot first        |
 * | Element detached from DOM     | STALE_REF   | Call browser_snapshot to refresh refs        |
 * | Execution context destroyed   | STALE_REF   | Page navigated — call browser_snapshot       |
 * | Blocked by policy (CORS etc.) | PERMISSION  | Blocked by browser security policy           |
 * | net::ERR_* navigation failure | EXTERNAL    | Check the URL is reachable                  |
 * | Page/target closed            | INTERNAL    | Browser page closed unexpectedly             |
 * | WebSocket disconnected        | INTERNAL    | Browser connection lost                      |
 * | JavaScript eval error         | EXTERNAL    | Page JS threw an error                       |
 * | Invalid CSS selector syntax   | VALIDATION  | Fix the CSS selector string                  |
 */

import type { KoiError } from "@koi/core";
import { external, internal, permission, staleRef, timeout, validation } from "@koi/core";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract a message string safely from an unknown caught value. */
function extractMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** True when the error's `.name` property equals the given value. */
function hasName(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name;
}

/** True when the message includes any of the given fragments. */
function msgIncludes(msg: string, ...fragments: readonly string[]): boolean {
  return fragments.some((f) => msg.includes(f));
}

// ---------------------------------------------------------------------------
// Main translator
// ---------------------------------------------------------------------------

/**
 * Convert a caught Playwright exception to a typed KoiError with actionable
 * guidance for LLM agents.
 *
 * @param operation - The browser operation that failed (e.g., "browser_click").
 *                    Used in fallback INTERNAL messages for traceability.
 * @param err       - The caught value from a catch block (`e: unknown`).
 */
export function translatePlaywrightError(operation: string, err: unknown): KoiError {
  const msg = extractMsg(err);

  // Pattern 1: TimeoutError — check .name since Playwright doesn't export the class
  if (hasName(err, "TimeoutError") || msgIncludes(msg, "Timeout ", "timeout exceeded")) {
    return timeout(
      `${operation} timed out — try browser_wait first, increase the timeout, ` +
        "or call browser_snapshot to verify the element is visible",
      2_000,
    );
  }

  // Pattern 2 & 3: Stale element / execution context destroyed
  // These both indicate the DOM or page changed after the last snapshot.
  if (
    msgIncludes(
      msg,
      "element is detached",
      "Element is detached",
      "element was detached",
      "is detached from document",
      "not attached to a Document",
      "element is not stable",
      "not stable",
    )
  ) {
    return staleRef(
      "element",
      "call browser_snapshot to get fresh refs — the DOM changed since your last snapshot",
    );
  }

  if (msgIncludes(msg, "Execution context was destroyed", "execution context was destroyed")) {
    return staleRef(
      "page",
      "the page navigated and all refs are now stale — call browser_snapshot to continue",
    );
  }

  // Pattern 4: CORS / policy / security blocks
  // Checked BEFORE generic net::ERR_* to avoid ERR_BLOCKED_BY_CLIENT being misclassified.
  if (
    msgIncludes(
      msg,
      "Access-Control-Allow-Origin",
      "CORS",
      "Cross-Origin",
      "Blocked by CORS policy",
      "ERR_BLOCKED_BY_CLIENT",
      "ERR_BLOCKED_BY_RESPONSE",
    )
  ) {
    return permission(
      `${operation} blocked by browser security policy (CORS or content policy) — ${msg}`,
    );
  }

  // Pattern 5: Network navigation failures
  if (
    msgIncludes(
      msg,
      "net::ERR_NAME_NOT_RESOLVED",
      "net::ERR_CONNECTION_REFUSED",
      "net::ERR_CONNECTION_TIMED_OUT",
      "net::ERR_ABORTED",
      "net::ERR_CERT_",
      "net::ERR_",
      "ERR_NAME_NOT_RESOLVED",
      "ERR_CONNECTION",
    )
  ) {
    return external(
      `${operation} failed: navigation error — check the URL is reachable (${msg})`,
      err,
    );
  }

  // Pattern 6: Page or browser target closed unexpectedly
  if (
    msgIncludes(
      msg,
      "Target closed",
      "Target page, context or browser has been closed",
      "Page closed",
      "page has been closed",
      "browser has disconnected",
    )
  ) {
    return internal(`${operation} failed: browser page was closed unexpectedly`, err);
  }

  // Pattern 7: WebSocket / CDP connection lost
  if (msgIncludes(msg, "WebSocket error", "socket hang up", "Connection closed")) {
    return internal(`${operation} failed: browser connection was lost`, err);
  }

  // Pattern 8: JavaScript evaluation errors (thrown inside the page)
  if (
    msgIncludes(
      msg,
      "Evaluation failed:",
      "evaluation failed",
      "Cannot read properties of",
      "is not defined",
      "is not a function",
    )
  ) {
    return external(`${operation} failed: JavaScript in the page threw an error — ${msg}`, err);
  }

  // Pattern 9: Invalid CSS selector syntax
  if (
    msgIncludes(
      msg,
      "is not a valid selector",
      "Failed to execute 'querySelector'",
      "Invalid selector",
      "SyntaxError: ",
    )
  ) {
    return validation(`${operation} failed: invalid CSS selector syntax — ${msg}`);
  }

  // Default: unexpected error, preserve cause for debugging
  return internal(`${operation} failed`, err);
}
