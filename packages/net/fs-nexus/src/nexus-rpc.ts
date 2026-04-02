/**
 * Path safety, error mapping, and RPC helper for Nexus filesystem operations.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { computeBackoff, type RetryConfig, sleep } from "@koi/errors";
import type { NexusTransport } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_BASE_PATH = "fs";
export const DEFAULT_RETRIES = 2;

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

/**
 * Join basePath with a user-provided path and normalize traversals.
 *
 * Prevents path traversal attacks by:
 * - Rejecting null bytes
 * - Normalizing backslash separators
 * - Decoding percent-encoded sequences
 * - Resolving `..` segments
 * - Verifying result stays within basePath boundary
 */
export function computeFullPath(basePath: string, userPath: string): Result<string, KoiError> {
  if (userPath.includes("\0")) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Path contains null bytes",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  let normalized: string;
  try {
    normalized = decodeURIComponent(userPath.replace(/\\/g, "/"));
  } catch {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Path contains malformed percent-encoding: '${userPath}'`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const normalizedUser = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  const joined = `${basePath}/${normalizedUser}`;

  const parts = joined.split("/");
  const resolved = parts.reduce<readonly string[]>((acc, part) => {
    if (part === "..") return acc.slice(0, -1);
    if (part !== "" && part !== ".") return acc.concat(part);
    return acc;
  }, []);
  const result = `/${resolved.join("/")}`;

  const normalizedBase = `/${basePath}`;
  const baseWithSlash = normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`;
  if (result !== normalizedBase && !result.startsWith(baseWithSlash)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Path traversal rejected: '${userPath}' escapes basePath '${basePath}'`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: result };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a server-returned path: decode percent-encoding, normalize
 * backslashes, resolve ".." segments. Applied before scope checks to
 * prevent encoded traversal forms from bypassing the basePath boundary.
 * Returns the original path unchanged if decoding fails.
 */
export function normalizeServerPath(path: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path.replace(/\\/g, "/"));
  } catch {
    return path;
  }
  // Resolve ".." segments to catch encoded traversal like %2e%2e
  const parts = decoded.split("/");
  const resolved = parts.reduce<readonly string[]>((acc, part) => {
    if (part === "..") return acc.slice(0, -1);
    if (part !== "" && part !== ".") return acc.concat(part);
    return acc;
  }, []);
  return decoded.startsWith("/") ? `/${resolved.join("/")}` : resolved.join("/");
}

/** Check if a full path is within the basePath boundary. */
export function isWithinBasePath(base: string, fullPath: string): boolean {
  const normalizedBase = base.startsWith("/") ? base : `/${base}`;
  if (fullPath === normalizedBase) return true;
  const baseWithSlash = normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`;
  return fullPath.startsWith(baseWithSlash);
}

/** Strip basePath prefix from a full path, returning the user-relative path. */
export function stripBasePath(base: string, fullPath: string): string {
  const normalizedBase = base.startsWith("/") ? base : `/${base}`;
  if (fullPath === normalizedBase) return "/";
  const baseWithSlash = normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`;
  if (fullPath.startsWith(baseWithSlash)) {
    return `/${fullPath.slice(baseWithSlash.length)}`;
  }
  return fullPath;
}

/** Map transport errors to KoiError. */
export function mapTransportError(error: unknown, method: string): KoiError {
  const msg = error instanceof Error ? error.message : String(error);
  const lowerMsg = msg.toLowerCase();

  if (lowerMsg.includes("not found") || lowerMsg.includes("404")) {
    return { code: "NOT_FOUND", message: msg, retryable: false };
  }
  if (lowerMsg.includes("permission") || lowerMsg.includes("403")) {
    return { code: "PERMISSION", message: msg, retryable: false };
  }
  if (lowerMsg.includes("conflict") || lowerMsg.includes("409")) {
    return { code: "CONFLICT", message: msg, retryable: false };
  }
  if (
    lowerMsg.includes("timed out") ||
    lowerMsg.includes("timeout") ||
    lowerMsg.includes("abort")
  ) {
    return { code: "TIMEOUT", message: msg, retryable: true };
  }
  if (
    lowerMsg.includes("connection") ||
    lowerMsg.includes("econnrefused") ||
    lowerMsg.includes("fetch")
  ) {
    return {
      code: "EXTERNAL",
      message: `Nexus unavailable for '${method}': ${msg}`,
      retryable: true,
    };
  }

  return {
    code: "EXTERNAL",
    message: `Nexus RPC '${method}' failed: ${msg}`,
    retryable: true,
    context: { method },
  };
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

const RETRY_CONFIG: RetryConfig = {
  maxRetries: DEFAULT_RETRIES,
  backoffMultiplier: 2,
  initialDelayMs: 200,
  maxBackoffMs: 5_000,
  jitter: true,
};

/**
 * Read-only RPC — retries transient failures with exponential backoff.
 * Safe because reads are idempotent.
 */
export async function rpcRead<T>(
  transport: NexusTransport,
  method: string,
  params: Record<string, unknown>,
  retries: number,
): Promise<Result<T, KoiError>> {
  let lastError: KoiError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await transport.call<T>(method, params);
      return { ok: true, value: result };
    } catch (error: unknown) {
      lastError = mapTransportError(error, method);
      if (!lastError.retryable || attempt >= retries) {
        return { ok: false, error: lastError };
      }
      const delay = computeBackoff(attempt, RETRY_CONFIG);
      await sleep(delay);
    }
  }

  // unreachable — loop always returns, but TS needs this
  return {
    ok: false,
    error: lastError ?? {
      code: "INTERNAL",
      message: "Retry loop exited without result",
      retryable: false,
    },
  };
}

/**
 * Mutating RPC — no automatic retries.
 *
 * Write, delete, and rename are not idempotent. Retrying after an ambiguous
 * failure (e.g. timeout where the server did apply the mutation) can cause
 * data loss or misleading errors. Callers must handle transient failures
 * explicitly if they need retry semantics (e.g. with idempotency keys).
 */
export async function rpcMutate<T>(
  transport: NexusTransport,
  method: string,
  params: Record<string, unknown>,
): Promise<Result<T, KoiError>> {
  try {
    const result = await transport.call<T>(method, params);
    return { ok: true, value: result };
  } catch (error: unknown) {
    const mapped = mapTransportError(error, method);
    // Force all mutation errors to non-retryable. Ambiguous failures
    // (timeout, connection drop) may have committed the mutation server-side.
    // Marking them retryable would invite duplicate writes/deletes/renames.
    return { ok: false, error: { ...mapped, retryable: false } };
  }
}
