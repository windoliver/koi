import type { KoiError, KoiErrorCode } from "@koi/core";

type TemporalFailureName =
  | "ApplicationFailure"
  | "TimeoutFailure"
  | "CancelledFailure"
  | "TerminatedFailure"
  | "ServerFailure";

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
};

export function mapTemporalError(error: unknown): KoiError {
  if (!isTemporalFailureLike(error)) {
    return {
      code: "INTERNAL",
      message: extractMessage(error),
      retryable: false,
      context: { source: "temporal", originalError: String(error) },
    };
  }

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

export interface ApplicationFailurePayload {
  readonly type: string;
  readonly message: string;
  readonly nonRetryable: boolean;
  readonly details: readonly [KoiError];
}

export function mapKoiErrorToApplicationFailure(error: KoiError): ApplicationFailurePayload {
  return {
    type: `KoiError:${error.code}`,
    message: error.message,
    nonRetryable: !error.retryable,
    details: [error],
  };
}

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
  if (error.name === "ApplicationFailure" && error.nonRetryable !== undefined) {
    return !error.nonRetryable;
  }
  if (error.name === "TimeoutFailure") return true;
  if (error.name === "CancelledFailure" || error.name === "TerminatedFailure") return false;
  return false;
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown Temporal error";
}
