/**
 * SQLite error mapping utilities.
 *
 * Maps bun:sqlite error messages to KoiError codes with proper
 * retryability and context. Uses a pattern table for exhaustive coverage.
 */

import type { KoiError, KoiErrorCode, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { extractMessage } from "@koi/errors";

// ---------------------------------------------------------------------------
// Pattern table
// ---------------------------------------------------------------------------

interface SqlitePattern {
  readonly pattern: RegExp;
  readonly code: KoiErrorCode;
  readonly retryable: boolean;
}

const SQLITE_PATTERNS: readonly SqlitePattern[] = [
  {
    pattern: /UNIQUE constraint|SQLITE_CONSTRAINT_UNIQUE/i,
    code: "CONFLICT",
    retryable: RETRYABLE_DEFAULTS.CONFLICT,
  },
  {
    pattern: /PRIMARY KEY constraint|SQLITE_CONSTRAINT_PRIMARYKEY/i,
    code: "CONFLICT",
    retryable: RETRYABLE_DEFAULTS.CONFLICT,
  },
  { pattern: /SQLITE_CONSTRAINT/i, code: "CONFLICT", retryable: RETRYABLE_DEFAULTS.CONFLICT },
  {
    pattern: /database is locked|SQLITE_BUSY/i,
    code: "TIMEOUT",
    retryable: RETRYABLE_DEFAULTS.TIMEOUT,
  },
  {
    pattern: /SQLITE_READONLY|readonly database/i,
    code: "PERMISSION",
    retryable: RETRYABLE_DEFAULTS.PERMISSION,
  },
  {
    pattern: /SQLITE_CORRUPT|database disk image/i,
    code: "INTERNAL",
    retryable: RETRYABLE_DEFAULTS.INTERNAL,
  },
  { pattern: /SQLITE_CANTOPEN/i, code: "NOT_FOUND", retryable: RETRYABLE_DEFAULTS.NOT_FOUND },
  { pattern: /SQLITE_FULL/i, code: "INTERNAL", retryable: RETRYABLE_DEFAULTS.INTERNAL },
  { pattern: /SQLITE_IOERR/i, code: "INTERNAL", retryable: RETRYABLE_DEFAULTS.INTERNAL },
  { pattern: /SQLITE_NOTADB/i, code: "INTERNAL", retryable: RETRYABLE_DEFAULTS.INTERNAL },
];

// ---------------------------------------------------------------------------
// Core mapping function
// ---------------------------------------------------------------------------

/** Map a caught SQLite error to a KoiError with appropriate code. */
export function mapSqliteError(e: unknown, context: string): KoiError {
  const message = extractMessage(e);

  for (const { pattern, code, retryable } of SQLITE_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code,
        message: `SQLite [${context}]: ${message}`,
        retryable,
        cause: e instanceof Error ? e : undefined,
        context: { operation: context },
      };
    }
  }

  return {
    code: "INTERNAL",
    message: `SQLite error in ${context}: ${message}`,
    retryable: RETRYABLE_DEFAULTS.INTERNAL,
    cause: e instanceof Error ? e : undefined,
    context: { operation: context },
  };
}

// ---------------------------------------------------------------------------
// Result wrapper
// ---------------------------------------------------------------------------

/** Execute a synchronous SQLite operation and return a Result. */
export function wrapSqlite<T>(fn: () => T, context: string): Result<T, KoiError> {
  try {
    return { ok: true, value: fn() };
  } catch (e: unknown) {
    return { ok: false, error: mapSqliteError(e, context) };
  }
}
