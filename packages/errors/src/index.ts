/**
 * @koi/errors — Shared runtime error class and utilities for L2 packages.
 *
 * Wraps the KoiError data type from @koi/core with a proper Error subclass,
 * giving middleware and feature packages stack traces + instanceof checks
 * while keeping L0 pure (types only).
 *
 * Also provides centralized error utilities (extractMessage, isKoiError,
 * toKoiError, etc.) and filesystem error mapping shared across L2 packages.
 */

export {
  extractCode,
  extractMessage,
  isContextOverflowError,
  isKoiError,
  swallowError,
  toKoiError,
} from "./error-utils.js";
export { mapFsError, mapParseError } from "./fs-errors.js";
export {
  calculateBackoff,
  DEFAULT_RETRY_CONFIG,
  isRetryable,
  type RetryConfig,
  withRetry,
} from "./retry.js";
export { KoiRuntimeError } from "./runtime-error.js";
