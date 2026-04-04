/**
 * Default FailureAnalyzer implementation.
 *
 * classify() — pattern-matches on KoiError codes and request shape.
 * selectAction() — escalation ladder based on retry count and failure class.
 */

import type {
  FailureAnalyzer,
  FailureClass,
  FailureClassKind,
  FailureContext,
  RetryAction,
  RetryRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// KoiError code → FailureClassKind mapping
// ---------------------------------------------------------------------------

const ERROR_CODE_MAP: Readonly<Record<string, FailureClassKind>> = {
  TIMEOUT: "api_error",
  RATE_LIMIT: "api_error",
  EXTERNAL: "api_error",
  VALIDATION: "validation_failure",
  NOT_FOUND: "tool_misuse",
  PERMISSION: "api_error",
  CONFLICT: "api_error",
  INTERNAL: "unknown",
  STALE_REF: "unknown",
} as const;

/** Default escalation ladder threshold — abort after this many prior retries. */
const DEFAULT_ABORT_THRESHOLD = 3;

/** Default model to escalate to when repeated failures of the same class occur. */
const DEFAULT_ESCALATION_MODEL = "claude-sonnet-4-5-20250514";

// ---------------------------------------------------------------------------
// classify helpers
// ---------------------------------------------------------------------------

/**
 * Type guard: check if error looks like a KoiError (has code + message).
 */
function hasErrorCode(
  error: unknown,
): error is { readonly code: string; readonly message: string } {
  if (error === null || error === undefined || typeof error !== "object") return false;
  if (!("code" in error) || !("message" in error)) return false;
  return typeof (error as Record<string, unknown>).code === "string";
}

function classifyByErrorCode(error: unknown): FailureClass | undefined {
  if (!hasErrorCode(error)) return undefined;
  const kind = ERROR_CODE_MAP[error.code];
  if (kind === undefined) return undefined;
  return { kind, reason: `KoiError code: ${error.code} — ${error.message}` };
}

function classifyByRequestShape(ctx: FailureContext): FailureClass | undefined {
  if ("kind" in ctx.request && ctx.request.kind === "tool") {
    return { kind: "tool_misuse", reason: `Tool call failed: ${ctx.request.toolId}` };
  }
  return undefined;
}

function classifyFallback(error: unknown): FailureClass {
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "unknown", reason: `Unrecognized error: ${message}` };
}

// ---------------------------------------------------------------------------
// selectAction helpers
// ---------------------------------------------------------------------------

/**
 * Check whether the most recent failures share the same FailureClassKind
 * as the current failure (indicates a persistent/repeating problem).
 */
function isRepeatingClass(current: FailureClass, records: readonly RetryRecord[]): boolean {
  if (records.length === 0) return false;
  const last = records[records.length - 1];
  return last !== undefined && last.failureClass.kind === current.kind;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a default FailureAnalyzer with pattern-matching classification
 * and an escalation ladder for action selection.
 */
export function createDefaultFailureAnalyzer(): FailureAnalyzer {
  return {
    classify(ctx: FailureContext): FailureClass {
      // Order: specific code match → request shape → fallback
      return (
        classifyByErrorCode(ctx.error) ?? classifyByRequestShape(ctx) ?? classifyFallback(ctx.error)
      );
    },

    selectAction(failure: FailureClass, records: readonly RetryRecord[]): RetryAction {
      const priorRetries = records.length;

      // Special case: scope_drift always triggers decompose on first attempt
      if (failure.kind === "scope_drift" && priorRetries < DEFAULT_ABORT_THRESHOLD) {
        return {
          kind: "decompose",
          subtasks: ["Re-read the original requirements", "Focus on one subtask at a time"],
        };
      }

      // Escalation ladder based on retry count
      if (priorRetries >= DEFAULT_ABORT_THRESHOLD) {
        return { kind: "abort", reason: `Retry budget exhausted after ${priorRetries} attempts` };
      }

      if (priorRetries === 0) {
        return { kind: "add_context", context: `Previous attempt failed: ${failure.reason}` };
      }

      if (priorRetries === 1) {
        return { kind: "narrow_scope", focusArea: "the specific failing operation" };
      }

      // priorRetries === 2: escalate or redirect depending on pattern
      if (isRepeatingClass(failure, records)) {
        return { kind: "escalate_model", targetModel: DEFAULT_ESCALATION_MODEL };
      }

      return { kind: "redirect", newApproach: "Try a fundamentally different strategy" };
    },
  };
}
