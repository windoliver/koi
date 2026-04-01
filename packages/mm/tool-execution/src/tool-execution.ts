/**
 * Per-call tool execution middleware factory.
 *
 * Wraps every tool call with:
 * - Abort signal composition (parent + per-tool timeout via AbortSignal.any)
 * - Per-tool timeout enforcement via Promise.race
 * - Pre-aborted signal short-circuit
 *
 * This middleware does NOT normalize errors into ToolResponse. Errors are
 * thrown as KoiRuntimeError (for timeout/abort) or re-thrown as-is (for tool
 * failures). Error-to-ToolResponse normalization is the engine adapter's
 * responsibility at the outermost boundary — doing it here would corrupt
 * governance accounting in outer middleware that distinguishes fulfilled
 * next() (success) from rejected next() (failure).
 */

import type { KoiMiddleware, ToolRequest } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ToolExecutionConfig {
  /** Global timeout for all tool calls in milliseconds. No timeout when absent. */
  readonly defaultTimeoutMs?: number | undefined;
  /** Per-tool timeout overrides. Takes precedence over defaultTimeoutMs. */
  readonly toolTimeouts?: Readonly<Record<string, number>> | undefined;
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

function validateTimeoutMs(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `${label} must be a finite positive number, got ${value}`,
      { context: { [label]: value } },
    );
  }
}

function validateConfig(config: ToolExecutionConfig): void {
  if (config.defaultTimeoutMs !== undefined) {
    validateTimeoutMs("defaultTimeoutMs", config.defaultTimeoutMs);
  }
  if (config.toolTimeouts !== undefined) {
    for (const [toolId, ms] of Object.entries(config.toolTimeouts)) {
      validateTimeoutMs(`toolTimeouts["${toolId}"]`, ms);
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
// Error classification
// ---------------------------------------------------------------------------

/**
 * Convert a DOMException from AbortSignal into a KoiRuntimeError.
 * Distinguishes timeout from abort via DOMException.name.
 * Non-DOMException errors are re-thrown as-is.
 */
function rethrowAsKoiError(error: unknown, toolId: string, timeoutMs: number | undefined): never {
  if (error instanceof DOMException) {
    if (error.name === "TimeoutError") {
      const msg =
        timeoutMs !== undefined
          ? `Tool "${toolId}" timed out after ${timeoutMs}ms`
          : `Tool "${toolId}" timed out`;
      throw KoiRuntimeError.from("TIMEOUT", msg, {
        retryable: false,
        context: { toolId, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
      });
    }
    if (error.name === "AbortError") {
      throw KoiRuntimeError.from("TIMEOUT", `Tool "${toolId}" was aborted`, {
        retryable: false,
        context: { toolId, abortReason: error.message },
      });
    }
  }
  // Re-throw non-DOMException errors as-is — preserves error type for
  // outer middleware (governance, telemetry) that inspect the thrown value.
  throw error;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a tool-execution middleware instance. */
export function createToolExecution(config?: ToolExecutionConfig): KoiMiddleware {
  if (config !== undefined) {
    validateConfig(config);
  }

  const defaultTimeoutMs = config?.defaultTimeoutMs;

  // Convert Record to Map at construction time for O(1) lookup
  const toolTimeouts: ReadonlyMap<string, number> =
    config?.toolTimeouts !== undefined ? new Map(Object.entries(config.toolTimeouts)) : new Map();

  return {
    name: "koi:tool-execution",
    priority: 100,
    phase: "resolve",
    describeCapabilities: () => undefined,

    wrapToolCall: async (_ctx, request, next) => {
      // 1. Check: is signal already aborted?
      if (request.signal?.aborted === true) {
        throw KoiRuntimeError.from("TIMEOUT", `Tool "${request.toolId}" was aborted`, {
          retryable: false,
          context: { toolId: request.toolId },
        });
      }

      // 2. Resolve timeout for this toolId
      const timeoutMs = resolveTimeoutMs(request.toolId, toolTimeouts, defaultTimeoutMs);

      // 3. Compose signal — only when timeout configured
      const composedSignal = composeSignal(request.signal, timeoutMs);

      // 4. Build the request to forward (only create new object if signal changed)
      const forwardRequest: ToolRequest =
        composedSignal !== request.signal ? { ...request, signal: composedSignal } : request;

      // 5. Execute — race against signal if present
      try {
        const toolPromise = next(forwardRequest);

        // Race tool execution against signal abort when a signal exists.
        // This ensures timeout/abort fires even if the tool ignores the signal.
        return composedSignal !== undefined
          ? await Promise.race([toolPromise, rejectOnAbort(composedSignal)])
          : await toolPromise;
      } catch (error: unknown) {
        rethrowAsKoiError(error, request.toolId, timeoutMs);
      }
    },
  };
}
