/**
 * Shared error helpers for @koi/artifact-client stores.
 *
 * Thin wrappers around @koi/core error factories with artifact-specific messages.
 * Used by memory-store, sqlite-store, and nexus-store.
 */

import type { KoiError, Result } from "@koi/core";
import { conflict, internal, notFound, validation } from "@koi/core";
import type { ArtifactId, ArtifactQuery } from "./types.js";

// ---------------------------------------------------------------------------
// Error factories
// ---------------------------------------------------------------------------

export function notFoundError(id: string): KoiError {
  return notFound(id, `Artifact not found: ${id}`);
}

export function conflictError(id: string): KoiError {
  return conflict(id, `Artifact already exists: ${id}`);
}

export function validationError(message: string): KoiError {
  return validation(message);
}

export function internalError(message: string, cause?: unknown): KoiError {
  return internal(message, cause);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function validateId(id: ArtifactId): Result<void, KoiError> {
  if (id === "") {
    return { ok: false, error: validationError("Artifact ID must not be empty") };
  }
  return { ok: true, value: undefined };
}

export function validateQuery(query: ArtifactQuery): Result<void, KoiError> {
  if (query.limit !== undefined && query.limit < 0) {
    return { ok: false, error: validationError("Query limit must not be negative") };
  }
  if (query.offset !== undefined && query.offset < 0) {
    return { ok: false, error: validationError("Query offset must not be negative") };
  }
  return { ok: true, value: undefined };
}
