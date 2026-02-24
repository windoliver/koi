import { describe, expect, test } from "bun:test";
import { translatePlaywrightError } from "./error-translator.js";

// ---------------------------------------------------------------------------
// Helper: construct a Playwright-style Error with a given name + message
// ---------------------------------------------------------------------------

function playwrightError(message: string, name = "Error"): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe("translatePlaywrightError", () => {
  // Pattern 1: TimeoutError
  test("maps TimeoutError (by name) to TIMEOUT code", () => {
    const err = playwrightError(
      "Timeout 3000ms exceeded while waiting for element",
      "TimeoutError",
    );
    const result = translatePlaywrightError("browser_click", err);
    expect(result.code).toBe("TIMEOUT");
    expect(result.message).toContain("browser_click");
    expect(result.message).toContain("browser_snapshot");
    expect(result.retryable).toBe(true);
  });

  test("maps message containing 'Timeout ' to TIMEOUT code", () => {
    const err = playwrightError("Timeout 5000ms exceeded");
    const result = translatePlaywrightError("browser_wait", err);
    expect(result.code).toBe("TIMEOUT");
  });

  // Pattern 2: Element detached from DOM
  test("maps 'element is detached' to STALE_REF code", () => {
    const err = playwrightError("locator.click: element is detached from document");
    const result = translatePlaywrightError("browser_click", err);
    expect(result.code).toBe("STALE_REF");
    expect(result.message).toContain("browser_snapshot");
    expect(result.retryable).toBe(false);
  });

  test("maps 'element is not stable' to STALE_REF code", () => {
    const err = playwrightError("locator.click: element is not stable");
    const result = translatePlaywrightError("browser_click", err);
    expect(result.code).toBe("STALE_REF");
  });

  test("maps 'not attached to a Document' to STALE_REF code", () => {
    const err = playwrightError("locator.fill: element is not attached to a Document");
    const result = translatePlaywrightError("browser_type", err);
    expect(result.code).toBe("STALE_REF");
  });

  // Pattern 3: Execution context destroyed
  test("maps 'Execution context was destroyed' to STALE_REF code", () => {
    const err = playwrightError(
      "Execution context was destroyed, most likely because of a navigation.",
    );
    const result = translatePlaywrightError("browser_click", err);
    expect(result.code).toBe("STALE_REF");
    expect(result.message).toContain("navigated");
    expect(result.message).toContain("browser_snapshot");
  });

  // Pattern 4: Network navigation failures
  test("maps net::ERR_NAME_NOT_RESOLVED to EXTERNAL code", () => {
    const err = playwrightError("net::ERR_NAME_NOT_RESOLVED at https://nonexistent.example");
    const result = translatePlaywrightError("browser_navigate", err);
    expect(result.code).toBe("EXTERNAL");
    expect(result.message).toContain("reachable");
    expect(result.cause).toBe(err);
  });

  test("maps net::ERR_CONNECTION_REFUSED to EXTERNAL code", () => {
    const err = playwrightError("net::ERR_CONNECTION_REFUSED");
    const result = translatePlaywrightError("browser_navigate", err);
    expect(result.code).toBe("EXTERNAL");
  });

  test("maps net::ERR_ABORTED to EXTERNAL code", () => {
    const err = playwrightError("net::ERR_ABORTED");
    const result = translatePlaywrightError("browser_navigate", err);
    expect(result.code).toBe("EXTERNAL");
  });

  // Pattern 5: Page/target closed
  test("maps 'Target closed' to INTERNAL code", () => {
    const err = playwrightError("Target closed.");
    const result = translatePlaywrightError("browser_click", err);
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toContain("closed unexpectedly");
    expect(result.cause).toBe(err);
  });

  test("maps 'page has been closed' to INTERNAL code", () => {
    const err = playwrightError("locator.click: page has been closed");
    const result = translatePlaywrightError("browser_click", err);
    expect(result.code).toBe("INTERNAL");
  });

  // Pattern 6: WebSocket / connection lost
  test("maps 'WebSocket error' to INTERNAL code", () => {
    const err = playwrightError("WebSocket error: connection refused");
    const result = translatePlaywrightError("browser_navigate", err);
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toContain("connection was lost");
  });

  // Pattern 7: JavaScript eval error
  test("maps 'Evaluation failed:' to EXTERNAL code", () => {
    const err = playwrightError("Evaluation failed: ReferenceError: window.myFn is not defined");
    const result = translatePlaywrightError("browser_evaluate", err);
    expect(result.code).toBe("EXTERNAL");
    expect(result.message).toContain("JavaScript");
    expect(result.cause).toBe(err);
  });

  test("maps 'is not a function' to EXTERNAL code", () => {
    const err = playwrightError("document.querySelectorAll is not a function");
    const result = translatePlaywrightError("browser_evaluate", err);
    expect(result.code).toBe("EXTERNAL");
  });

  // Pattern 8: Invalid CSS selector
  test("maps 'is not a valid selector' to VALIDATION code", () => {
    const err = playwrightError(".foo[[bar] is not a valid selector");
    const result = translatePlaywrightError("browser_wait", err);
    expect(result.code).toBe("VALIDATION");
    expect(result.retryable).toBe(false);
  });

  test("maps 'Failed to execute querySelector' to VALIDATION code", () => {
    const err = playwrightError(
      "Failed to execute 'querySelector' on 'Document': '#bad>>' is not a valid selector.",
    );
    const result = translatePlaywrightError("browser_wait", err);
    expect(result.code).toBe("VALIDATION");
  });

  // Pattern 9: CORS / security policy
  test("maps CORS error to PERMISSION code", () => {
    const err = playwrightError("Blocked by CORS policy: No 'Access-Control-Allow-Origin' header");
    const result = translatePlaywrightError("browser_navigate", err);
    expect(result.code).toBe("PERMISSION");
    expect(result.message).toContain("security policy");
  });

  test("maps ERR_BLOCKED_BY_CLIENT to PERMISSION code", () => {
    const err = playwrightError("net::ERR_BLOCKED_BY_CLIENT");
    const result = translatePlaywrightError("browser_navigate", err);
    expect(result.code).toBe("PERMISSION");
  });

  // Default fallback
  test("defaults unknown errors to INTERNAL with cause preserved", () => {
    const err = playwrightError("Something completely unexpected happened");
    const result = translatePlaywrightError("browser_click", err);
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toContain("browser_click");
    expect(result.cause).toBe(err);
  });

  test("handles non-Error thrown values", () => {
    const result = translatePlaywrightError("browser_click", "raw string error");
    expect(result.code).toBe("INTERNAL");
  });

  // Operation name appears in error messages for traceability
  test("includes operation name in TIMEOUT messages", () => {
    const err = playwrightError("Timeout 3000ms exceeded", "TimeoutError");
    const result = translatePlaywrightError("browser_fill_form", err);
    expect(result.message).toContain("browser_fill_form");
  });

  test("includes operation name in EXTERNAL messages", () => {
    const err = playwrightError("net::ERR_CONNECTION_REFUSED");
    const result = translatePlaywrightError("browser_navigate", err);
    expect(result.message).toContain("browser_navigate");
  });
});
