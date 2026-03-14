/**
 * Validation-specific FailureAnalyzer plugin.
 *
 * classify: Returns "validation_failure" for VALIDATION KoiError codes,
 * extracting context.issues when available. Falls back to an optional
 * delegate analyzer for non-validation errors.
 *
 * selectAction: Always returns "add_context" with the actual error details.
 * Never escalates model (validation errors are deterministic). Aborts after
 * budget exhaustion.
 */

import type {
  FailureAnalyzer,
  FailureClass,
  FailureContext,
  RetryAction,
  RetryRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Checks whether an error looks like a KoiError with code + message fields. */
function hasErrorCode(
  error: unknown,
): error is { readonly code: string; readonly message: string; readonly context?: unknown } {
  if (error === null || error === undefined || typeof error !== "object") return false;
  if (!("code" in error) || !("message" in error)) return false;
  // eslint-disable-next-line -- `as Record` is required: TS does not narrow `in` checks to indexable
  return typeof (error as Record<string, unknown>).code === "string";
}

/** Extracts a human-readable string from KoiError.context.issues if present. */
function extractIssues(error: unknown): string | undefined {
  if (error === null || error === undefined || typeof error !== "object") return undefined;
  if (!("context" in error)) return undefined;
  // eslint-disable-next-line -- accessing unknown shape via Record for inspection
  const ctx = (error as Record<string, unknown>).context;
  if (ctx === null || ctx === undefined || typeof ctx !== "object") return undefined;
  if (!("issues" in ctx)) return undefined;
  // eslint-disable-next-line -- issues can be any shape, we serialize it
  const issues = (ctx as Record<string, unknown>).issues;
  if (issues === undefined) return undefined;
  return typeof issues === "string" ? issues : JSON.stringify(issues);
}

/** Builds a reason string from a VALIDATION KoiError, including issues if present. */
function buildValidationReason(error: unknown): string {
  const message = hasErrorCode(error) ? error.message : String(error);
  const issues = extractIssues(error);
  if (issues !== undefined) {
    return `Validation failed: ${message} — Issues: ${issues}`;
  }
  return `Validation failed: ${message}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a validation-specific FailureAnalyzer.
 *
 * For VALIDATION KoiError codes, always classifies as "validation_failure"
 * and extracts the actual error message/context in the reason.
 * Falls back to the provided fallback analyzer for non-validation errors.
 *
 * selectAction always returns "add_context" with the actual validation error
 * details. Never escalates model or narrows scope — validation errors are
 * deterministic. Returns "abort" when no prior retries remain (budget check
 * done upstream by the middleware).
 */
export function createValidationAnalyzer(fallback?: FailureAnalyzer): FailureAnalyzer {
  return {
    classify(ctx: FailureContext): FailureClass | Promise<FailureClass> {
      if (hasErrorCode(ctx.error) && ctx.error.code === "VALIDATION") {
        return {
          kind: "validation_failure",
          reason: buildValidationReason(ctx.error),
        };
      }

      // Non-validation: delegate to fallback or return unknown
      if (fallback !== undefined) {
        return fallback.classify(ctx);
      }
      const message = ctx.error instanceof Error ? ctx.error.message : String(ctx.error);
      return { kind: "unknown", reason: `Unrecognized error: ${message}` };
    },

    selectAction(failure: FailureClass, records: readonly RetryRecord[]): RetryAction {
      // For non-validation failures, delegate to fallback
      if (failure.kind !== "validation_failure") {
        if (fallback !== undefined) {
          return fallback.selectAction(failure, records);
        }
        return { kind: "add_context", context: `Previous attempt failed: ${failure.reason}` };
      }

      // Count prior validation-specific retries
      const validationRetries = records.filter(
        (r) => r.failureClass.kind === "validation_failure",
      ).length;

      // Abort if we've already retried validation errors
      if (validationRetries > 0) {
        return {
          kind: "abort",
          reason: `Validation error persists after ${validationRetries} retry attempt(s)`,
        };
      }

      // First validation retry: provide the actual error details as context
      return {
        kind: "add_context",
        context: failure.reason,
      };
    },
  };
}
