/**
 * Type-narrowing assertions for Result<T, KoiError>.
 *
 * These use TypeScript assertion functions so downstream code can access
 * `.value` or `.error` directly after a call without an additional guard.
 */

import type { KoiError, KoiErrorCode, Result } from "@koi/core";

export function assertOk<T>(
  result: Result<T, KoiError>,
): asserts result is { readonly ok: true; readonly value: T } {
  if (!result.ok) {
    throw new Error(
      `assertOk: expected Ok, got Err (code=${result.error.code}, message=${result.error.message})`,
    );
  }
}

export function assertErr<T>(
  result: Result<T, KoiError>,
): asserts result is { readonly ok: false; readonly error: KoiError } {
  if (result.ok) {
    throw new Error(`assertErr: expected Err, got Ok (value=${JSON.stringify(result.value)})`);
  }
}

export function assertErrCode<T>(
  result: Result<T, KoiError>,
  code: KoiErrorCode,
): asserts result is { readonly ok: false; readonly error: KoiError } {
  assertErr(result);
  if (result.error.code !== code) {
    throw new Error(
      `assertErrCode: expected code=${code}, got code=${result.error.code} (message=${result.error.message})`,
    );
  }
}
