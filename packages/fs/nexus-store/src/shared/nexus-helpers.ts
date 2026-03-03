/**
 * Shared Nexus RPC helpers for all adapters in @koi/nexus-store.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS, validation } from "@koi/core";

/** Wrap a Nexus error with the standard KoiError shape. */
export function wrapNexusError(code: KoiError["code"], message: string, cause?: unknown): KoiError {
  return { code, message, retryable: RETRYABLE_DEFAULTS[code] ?? false, cause };
}

/**
 * Validate that a string is safe to use as a Nexus path segment.
 * Rejects empty strings, path separators, and traversal sequences.
 */
export function validatePathSegment(segment: string, label: string): Result<void, KoiError> {
  if (segment === "" || segment.includes("/") || segment.includes("\\") || segment.includes("..")) {
    return {
      ok: false,
      error: validation(`${label} contains invalid path characters: ${segment}`),
    };
  }
  return { ok: true, value: undefined };
}
