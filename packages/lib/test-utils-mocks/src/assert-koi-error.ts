/**
 * Test assertion helper for KoiError validation.
 *
 * Provides a reusable assertion that verifies a value conforms to the
 * KoiError shape with valid code, message, and retryable fields.
 */

import { expect } from "bun:test";
import type { KoiErrorCode } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

const VALID_CODES: ReadonlySet<string> = new Set<string>(Object.keys(RETRYABLE_DEFAULTS));

/** Assert a value is a valid KoiError with expected properties. */
export function assertKoiError(
  error: unknown,
  expected?: { readonly code?: KoiErrorCode; readonly retryable?: boolean },
): void {
  expect(error).toBeDefined();
  expect(typeof error).toBe("object");
  const e = error as Record<string, unknown>;
  expect(typeof e.message).toBe("string");
  expect((e.message as string).length).toBeGreaterThan(0);
  expect(typeof e.retryable).toBe("boolean");
  expect(VALID_CODES.has(String(e.code))).toBe(true);
  if (expected?.code !== undefined) expect(e.code).toBe(expected.code);
  if (expected?.retryable !== undefined) expect(e.retryable).toBe(expected.retryable);
}
