/**
 * Bidirectional error mapping between KoiError and Temporal error types.
 *
 * System boundary module (Decision 6A): maps KoiError.retryable to Temporal's
 * nonRetryable flag, and Temporal failure types back to KoiError codes.
 */

import type { KoiError, KoiErrorCode } from "@koi/core";

// ---------------------------------------------------------------------------
// Temporal → KoiError mapping
// ---------------------------------------------------------------------------

/**
 * Temporal failure type discriminator.
 * Temporal SDK throws typed errors with a `name` property.
 */
type TemporalFailureName =
  | "ApplicationFailure"
  | "TimeoutFailure"
  | "CancelledFailure"
  | "TerminatedFailure"
  | "ServerFailure";

/** Known Temporal failure shape (structural typing, no SDK import needed). */
interface TemporalFailureLike {
  readonly name: string;
  readonly message: string;
  readonly cause?: unknown;
  /** ApplicationFailure-specific: original error type name. */
  readonly type?: string;
  /** ApplicationFailure-specific: whether the error is non-retryable. */
  readonly nonRetryable?: boolean;
  /** ApplicationFailure-specific: serialized details. */
  readonly details?: readonly unknown[];
}

const TEMPORAL_TO_KOI_CODE: Readonly<Record<TemporalFailureName, KoiErrorCode>> = {
  ApplicationFailure: "INTERNAL",
  TimeoutFailure: "TIMEOUT",
  CancelledFailure: "CANCELLED",
  TerminatedFailure: "CANCELLED",
  ServerFailure: "INTERNAL",
};

/**
 * Map a Temporal error to a KoiError.
 *
 * Handles:
 * - ApplicationFailure with embedded KoiError payload → round-trips correctly
 * - TimeoutFailure → KoiError { code: "TIMEOUT", retryable: true }
 * - CancelledFailure → KoiError { code: "CANCELLED", retryable: false }
 * - Unknown errors → KoiError { code: "INTERNAL", retryable: false }
 */
export function mapTemporalError(error: unknown): KoiError {
  if (!isTemporalFailureLike(error)) {
    return {
      code: "INTERNAL",
      message: extractMessage(error),
      retryable: false,
      context: { source: "temporal", originalError: String(error) },
    };
  }

  // Check for round-tripped KoiError in ApplicationFailure details
  if (error.name === "ApplicationFailure" && error.details !== undefined) {
    const embedded = error.details[0];
    if (isKoiErrorPayload(embedded)) {
      return embedded;
    }
  }

  const code = TEMPORAL_TO_KOI_CODE[error.name as TemporalFailureName] ?? "INTERNAL";
  const retryable = resolveRetryable(error);

  return {
    code,
    message: error.message,
    retryable,
    context: { source: "temporal", temporalFailureType: error.name },
  };
}

// ---------------------------------------------------------------------------
// KoiError → Temporal ApplicationFailure mapping
// ---------------------------------------------------------------------------

/**
 * Payload shape for an ApplicationFailure that wraps a KoiError.
 * Temporal serializes the `details` array — the KoiError is the first element.
 */
export interface ApplicationFailurePayload {
  readonly type: string;
  readonly message: string;
  readonly nonRetryable: boolean;
  readonly details: readonly [KoiError];
}

/**
 * Map a KoiError to an ApplicationFailure-compatible payload.
 *
 * The KoiError is embedded in `details[0]` so it round-trips through
 * `mapTemporalError()` on the receiving side.
 */
export function mapKoiErrorToApplicationFailure(error: KoiError): ApplicationFailurePayload {
  return {
    type: `KoiError:${error.code}`,
    message: error.message,
    nonRetryable: !error.retryable,
    details: [error],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTemporalFailureLike(value: unknown): value is TemporalFailureLike {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.name === "string" && typeof obj.message === "string";
}

function isKoiErrorPayload(value: unknown): value is KoiError {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.code === "string" &&
    typeof obj.message === "string" &&
    typeof obj.retryable === "boolean"
  );
}

function resolveRetryable(error: TemporalFailureLike): boolean {
  // ApplicationFailure: use nonRetryable flag (inverted)
  if (error.name === "ApplicationFailure" && error.nonRetryable !== undefined) {
    return !error.nonRetryable;
  }
  // TimeoutFailure: retryable by default (transient)
  if (error.name === "TimeoutFailure") return true;
  // CancelledFailure/TerminatedFailure: not retryable (intentional)
  if (error.name === "CancelledFailure" || error.name === "TerminatedFailure") return false;
  // Default: not retryable
  return false;
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown Temporal error";
}
