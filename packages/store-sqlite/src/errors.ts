/**
 * SQLite error mapping utilities.
 *
 * Maps bun:sqlite error messages to KoiError codes with proper
 * retryability and context. Provides wrapSqlite for ergonomic
 * try/catch → Result conversion.
 */

import type { KoiError, Result } from "@koi/core";
import { conflict, internal, permission, timeout } from "@koi/core";

/** Map a caught SQLite error to a KoiError with appropriate code. */
export function mapSqliteError(e: unknown, context: string): KoiError {
  const message = e instanceof Error ? e.message : String(e);

  if (message.includes("UNIQUE constraint") || message.includes("SQLITE_CONSTRAINT")) {
    return conflict(context, `SQLite constraint violation: ${context}`);
  }
  if (message.includes("database is locked") || message.includes("SQLITE_BUSY")) {
    return timeout(`SQLite busy: ${context}`);
  }
  if (message.includes("SQLITE_READONLY") || message.includes("readonly database")) {
    return permission(`SQLite readonly: ${context}`);
  }
  if (message.includes("SQLITE_CORRUPT") || message.includes("database disk image")) {
    return internal(`SQLite corrupt: ${context}`, e);
  }

  return internal(`SQLite error in ${context}: ${message}`, e);
}

/** Execute a synchronous SQLite operation and return a Result. */
export function wrapSqlite<T>(fn: () => T, context: string): Result<T, KoiError> {
  try {
    return { ok: true, value: fn() };
  } catch (e: unknown) {
    return { ok: false, error: mapSqliteError(e, context) };
  }
}
