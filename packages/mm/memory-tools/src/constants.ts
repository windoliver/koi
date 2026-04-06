/**
 * Memory tool constants — defaults for prefix, limits, and operation list.
 */

import type { KoiError, Result } from "@koi/core";

/** Default tool name prefix (e.g. "memory_store", "memory_recall"). */
export const DEFAULT_PREFIX = "memory";

/** Default maximum results for memory_recall. */
export const DEFAULT_RECALL_LIMIT = 10;

/** Default maximum results for memory_search. */
export const DEFAULT_SEARCH_LIMIT = 20;

/** All memory tool operations. */
export const MEMORY_OPERATIONS = ["store", "recall", "search", "delete"] as const;

/**
 * Minimum depth (number of `/`-separated non-empty segments) for memoryDir.
 * Rejects dangerously broad paths like `/`, `/tmp`, `/home`.
 */
const MIN_MEMORY_DIR_DEPTH = 2;

/**
 * Validate memoryDir for use as a sandbox filesystem boundary.
 *
 * Returns `ok: true` with the validated path on success, or a
 * Result error describing what is wrong. Used by both the provider
 * and individual tool constructors to prevent bypass.
 */
export function validateMemoryDir(memoryDir: string): Result<string, KoiError> {
  if (typeof memoryDir !== "string" || memoryDir.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "memoryDir is required and must be a non-empty string",
        retryable: false,
      },
    };
  }

  if (!memoryDir.startsWith("/")) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "memoryDir must be an absolute path (start with /)",
        retryable: false,
      },
    };
  }

  if (/(^|\/)\.\.(\/|$)/.test(memoryDir)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "memoryDir must not contain '..' traversal segments",
        retryable: false,
      },
    };
  }

  // Reject dangerously broad paths (e.g. "/", "/tmp", "/home")
  const segments = memoryDir.split("/").filter((s) => s.length > 0);
  if (segments.length < MIN_MEMORY_DIR_DEPTH) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `memoryDir must have at least ${String(MIN_MEMORY_DIR_DEPTH)} path segments to avoid over-broad filesystem access (got "${memoryDir}")`,
        retryable: false,
      },
    };
  }

  return { ok: true, value: memoryDir };
}
