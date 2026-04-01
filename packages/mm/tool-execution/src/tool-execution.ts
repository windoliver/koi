/**
 * Per-call tool execution middleware factory.
 *
 * Wraps every tool call with:
 * - Abort signal composition (parent + per-tool timeout)
 * - Deterministic error normalization (never throws on tool failure)
 * - Transparent pass-through on success
 */

import type { JsonObject, KoiMiddleware, ToolRequest, ToolResponse } from "@koi/core";
import { formatToolError, toKoiError } from "@koi/errors";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ToolExecutionConfig {
  /** Global timeout for all tool calls in milliseconds. No timeout when absent. */
  readonly defaultTimeoutMs?: number | undefined;
  /** Per-tool timeout overrides. Takes precedence over defaultTimeoutMs. */
  readonly toolTimeouts?: Readonly<Record<string, number>> | undefined;
  /** Include stack trace in error responses. Default: false. */
  readonly includeStackInResponse?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Internal discriminated union for type-safe error classification
// ---------------------------------------------------------------------------

type ToolCallOutcome =
  | { readonly kind: "success"; readonly response: ToolResponse }
  | { readonly kind: "tool_error"; readonly error: unknown }
  | { readonly kind: "timeout"; readonly timeoutMs: number | undefined }
  | { readonly kind: "aborted"; readonly reason: unknown };

/**
 * Classify a caught error into a ToolCallOutcome.
 * Distinguishes abort vs timeout vs generic tool error via DOMException.name.
 */
function classifyError(error: unknown): ToolCallOutcome {
  if (error instanceof DOMException) {
    if (error.name === "AbortError") {
      return { kind: "aborted", reason: error.message };
    }
    if (error.name === "TimeoutError") {
      return { kind: "timeout", timeoutMs: undefined };
    }
  }
  return { kind: "tool_error", error };
}

/**
 * Map a ToolCallOutcome to a ToolResponse.
 * Every outcome variant produces a valid response — never throws.
 */
function mapOutcomeToResponse(
  outcome: ToolCallOutcome,
  toolId: string,
  configuredTimeoutMs: number | undefined,
  includeStack: boolean,
): ToolResponse {
  switch (outcome.kind) {
    case "success":
      return outcome.response;

    case "aborted":
      return {
        output: "Tool call aborted",
        metadata: {
          _error: { kind: "aborted" } satisfies JsonObject,
        },
      };

    case "timeout": {
      const ms = outcome.timeoutMs ?? configuredTimeoutMs;
      const message =
        ms !== undefined ? `Tool call timed out after ${ms}ms` : "Tool call timed out";
      return {
        output: message,
        metadata: {
          _error: {
            kind: "timeout",
            ...(ms !== undefined ? { timeoutMs: ms } : {}),
          } satisfies JsonObject,
        },
      };
    }

    case "tool_error": {
      const koiError = toKoiError(outcome.error);
      const errorMeta: Record<string, unknown> = {
        kind: "tool_error",
        code: koiError.code,
        retryable: koiError.retryable,
      };
      if (includeStack && outcome.error instanceof Error && outcome.error.stack !== undefined) {
        errorMeta.stack = outcome.error.stack;
      }
      return {
        output: formatToolError(outcome.error, toolId),
        metadata: { _error: errorMeta as JsonObject },
      };
    }

    default: {
      const _exhaustive: never = outcome;
      throw new Error(`Unhandled outcome kind: ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Signal composition
// ---------------------------------------------------------------------------

/**
 * Resolve the effective timeout for a tool call.
 * Per-tool overrides take precedence over the global default.
 */
function resolveTimeoutMs(
  toolId: string,
  toolTimeouts: ReadonlyMap<string, number>,
  defaultTimeoutMs: number | undefined,
): number | undefined {
  return toolTimeouts.get(toolId) ?? defaultTimeoutMs;
}

/**
 * Compose a parent signal with a per-call timeout.
 * Returns the original signal unchanged when no timeout is configured.
 * Returns undefined when no signal and no timeout exist.
 */
function composeSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) {
    return parentSignal;
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (parentSignal === undefined) {
    return timeoutSignal;
  }
  return AbortSignal.any([parentSignal, timeoutSignal]);
}

/**
 * Create a promise that rejects when the given signal fires.
 * Used to race against tool execution for timeout/abort enforcement.
 * The signal's reason is preserved to distinguish AbortError vs TimeoutError.
 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const doReject = (): void => {
      const reason: unknown = signal.reason;
      if (reason instanceof DOMException) {
        reject(reason);
      } else {
        reject(new DOMException("The operation was aborted", "AbortError"));
      }
    };

    // If already aborted (race between pre-check and here), reject immediately
    if (signal.aborted) {
      doReject();
      return;
    }

    signal.addEventListener("abort", doReject, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a tool-execution middleware instance. */
export function createToolExecution(config?: ToolExecutionConfig): KoiMiddleware {
  const defaultTimeoutMs = config?.defaultTimeoutMs;
  const includeStack = config?.includeStackInResponse ?? false;

  // Convert Record to Map at construction time for O(1) lookup (Decision #15A)
  const toolTimeouts: ReadonlyMap<string, number> =
    config?.toolTimeouts !== undefined ? new Map(Object.entries(config.toolTimeouts)) : new Map();

  return {
    name: "koi:tool-execution",
    priority: 100,
    phase: "resolve",
    describeCapabilities: () => undefined,

    wrapToolCall: async (_ctx, request, next) => {
      // 1. Check: is signal already aborted? (Decision #9A scenario 1)
      if (request.signal?.aborted === true) {
        return mapOutcomeToResponse(
          { kind: "aborted", reason: request.signal.reason },
          request.toolId,
          undefined,
          includeStack,
        );
      }

      // 2. Resolve timeout for this toolId (Decision #7B)
      const timeoutMs = resolveTimeoutMs(request.toolId, toolTimeouts, defaultTimeoutMs);

      // 3. Compose signal — only when timeout configured (Decision #13A)
      const composedSignal = composeSignal(request.signal, timeoutMs);

      // 4. Build the request to forward (only create new object if signal changed)
      const forwardRequest: ToolRequest =
        composedSignal !== request.signal ? { ...request, signal: composedSignal } : request;

      // 5. Execute — race against signal if present
      try {
        const toolPromise = next(forwardRequest);

        // Race tool execution against signal abort when a signal exists.
        // This ensures timeout/abort fires even if the tool ignores the signal.
        const response: ToolResponse =
          composedSignal !== undefined
            ? await Promise.race([toolPromise, rejectOnAbort(composedSignal)])
            : await toolPromise;

        // Pure transparency: return the response unchanged (Decision #11B)
        return response;
      } catch (error: unknown) {
        const outcome = classifyError(error);
        return mapOutcomeToResponse(outcome, request.toolId, timeoutMs, includeStack);
      }
    },
  };
}
