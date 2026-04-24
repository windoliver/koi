/**
 * Bidirectional error mapping between KoiError and Temporal failure types.
 *
 * System boundary: maps KoiError.retryable to Temporal's nonRetryable flag,
 * and Temporal failure names back to KoiError codes.
 *
 * No @temporalio/* imports — uses structural typing throughout.
 */

import type { KoiError, KoiErrorCode } from "@koi/core";

// ---------------------------------------------------------------------------
// Structural types (no @temporalio/* imports)
// ---------------------------------------------------------------------------

type TemporalFailureName =
  | "ApplicationFailure"
  | "CancelledFailure"
  | "ServerFailure"
  | "TerminatedFailure"
  | "TimeoutFailure";

interface TemporalFailureLike {
  readonly name: string;
  readonly message: string;
  readonly cause?: unknown;
  readonly type?: string;
  readonly nonRetryable?: boolean;
  readonly details?: readonly unknown[];
}

const TEMPORAL_TO_KOI_CODE: Readonly<Record<TemporalFailureName, KoiErrorCode>> = {
  ApplicationFailure: "INTERNAL",
  TimeoutFailure: "TIMEOUT",
  CancelledFailure: "EXTERNAL",
  TerminatedFailure: "EXTERNAL",
  ServerFailure: "INTERNAL",
} as const;

// ---------------------------------------------------------------------------
// Temporal → KoiError
// ---------------------------------------------------------------------------

export function mapTemporalError(error: unknown): KoiError {
  if (!isTemporalFailureLike(error)) {
    return {
      code: "INTERNAL",
      message: extractMessage(error),
      retryable: false,
      context: { source: "temporal", originalError: String(error) },
    };
  }

  // Round-trip: ApplicationFailure may embed a serialized KoiError in details[0]
  if (error.name === "ApplicationFailure" && error.details !== undefined) {
    const embedded = error.details[0];
    if (isKoiErrorPayload(embedded)) return embedded;
  }

  const name = error.name as TemporalFailureName;
  const code = TEMPORAL_TO_KOI_CODE[name] ?? "INTERNAL";

  return {
    code,
    message: error.message,
    retryable: resolveRetryable(error),
    context: { source: "temporal", temporalFailureType: error.name },
  };
}

// ---------------------------------------------------------------------------
// KoiError → ApplicationFailure payload
// ---------------------------------------------------------------------------

export interface ApplicationFailurePayload {
  readonly message: string;
  readonly type: string;
  readonly nonRetryable: boolean;
  readonly details: readonly [KoiError];
}

export function mapKoiErrorToApplicationFailure(err: KoiError): ApplicationFailurePayload {
  return {
    message: err.message,
    type: err.code,
    nonRetryable: !err.retryable,
    details: [err],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTemporalFailureLike(e: unknown): e is TemporalFailureLike {
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    "message" in e &&
    typeof (e as Record<string, unknown>).name === "string" &&
    typeof (e as Record<string, unknown>).message === "string"
  );
}

function isKoiErrorPayload(v: unknown): v is KoiError {
  return typeof v === "object" && v !== null && "code" in v && "message" in v && "retryable" in v;
}

function resolveRetryable(e: TemporalFailureLike): boolean {
  if (e.nonRetryable !== undefined) return !e.nonRetryable;
  const name = e.name as TemporalFailureName;
  return name === "TimeoutFailure" || name === "ServerFailure";
}

function extractMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
