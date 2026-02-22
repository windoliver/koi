/**
 * Shared error utilities for the model-router package.
 *
 * Converts unknown errors into typed KoiError values.
 */

import type { KoiError } from "@koi/core";

export function isKoiError(error: unknown): error is KoiError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "retryable" in error
  );
}

export function toKoiError(error: unknown): KoiError {
  if (isKoiError(error)) return error;
  return {
    code: "EXTERNAL",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    cause: error,
  };
}
