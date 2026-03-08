/**
 * Shared error helpers for @koi/handoff stores.
 *
 * Thin wrappers around @koi/core error factories with handoff-specific messages.
 * Used by in-memory, sqlite, and nexus store implementations.
 */

import type { KoiError, Result } from "@koi/core";
import { conflict, internal, notFound, validation } from "@koi/core";

// ---------------------------------------------------------------------------
// Error factories
// ---------------------------------------------------------------------------

export function notFoundError(id: string): KoiError {
  return notFound(id, `Handoff envelope not found: ${id}`);
}

export function conflictError(id: string): KoiError {
  return conflict(id, `Handoff envelope already exists: ${id}`);
}

export function validationError(message: string): KoiError {
  return validation(message);
}

export function expiredError(id: string): KoiError {
  return notFound(id, `Handoff envelope expired (TTL exceeded): ${id}`);
}

export function internalError(message: string, cause?: unknown): KoiError {
  return internal(message, cause);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function validateHandoffId(id: string): Result<void, KoiError> {
  if (id === "") {
    return { ok: false, error: validationError("Handoff ID must not be empty") };
  }
  return { ok: true, value: undefined };
}
