/**
 * Per-call tool execution middleware factory.
 *
 * Wraps every tool call with:
 * - Abort signal composition (parent + per-call timeout via AbortSignal.any)
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
// Signal + timeout composition
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
 * Result of composing a signal with a timeout.
 * The caller MUST invoke cleanup() in a finally block to clear the timer
 * and remove the abort listener — prevents timer leaks and listener
 * accumulation on reused signals.
 */
interface ComposedSignal {
  readonly signal: AbortSignal;
  /** Racing promise that rejects when the signal fires. */
  readonly racePromise: Promise<never>;
  /** Clear timeout timer + remove abort listener. MUST be called in finally. */
  readonly cleanup: () => void;
}

/**
 * Compose a parent signal with a per-call timeout, returning an abort race
 * promise and a cleanup function that cancels the timer immediately.
 *
 * Uses a manual AbortController + setTimeout instead of AbortSignal.timeout()
 * so the timer can be cleared when the tool completes — preventing timer
 * accumulation under load with long default timeouts.
 */
function createComposedSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): ComposedSignal | undefined {
  // No timeout and no parent signal → nothing to compose
  if (timeoutMs === undefined && parentSignal === undefined) {
    return undefined;
  }

  // No timeout → just race against the parent signal (no timer to clean up)
  if (timeoutMs === undefined && parentSignal !== undefined) {
    return createAbortRace(parentSignal, undefined);
  }

  // Create a manually-managed timeout controller so we can clear the timer
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new DOMException("The operation timed out", "TimeoutError"));
  }, timeoutMs);

  // Compose parent + timeout signals, or just use timeout signal
  const composedSignal =
    parentSignal !== undefined
      ? AbortSignal.any([parentSignal, timeoutController.signal])
      : timeoutController.signal;

  return createAbortRace(composedSignal, () => {
    clearTimeout(timer);
  });
}

/**
 * Create a racing promise + cleanup from a composed signal.
 * The optional extraCleanup callback clears any timer resources.
 */
function createAbortRace(
  signal: AbortSignal,
  extraCleanup: (() => void) | undefined,
): ComposedSignal {
  // If already aborted, return an immediately-rejecting promise (no listener needed)
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    const error =
      reason instanceof DOMException
        ? reason
        : new DOMException("The operation was aborted", "AbortError");
    extraCleanup?.();
    return {
      signal,
      racePromise: Promise.reject(error),
      cleanup: () => {},
    };
  }

  // let justified: mutable binding swapped by doReject/cleanup to break the closure
  let rejectFn: ((reason: unknown) => void) | undefined;

  const doReject = (): void => {
    if (rejectFn === undefined) return;
    const reason: unknown = signal.reason;
    if (reason instanceof DOMException) {
      rejectFn(reason);
    } else {
      rejectFn(new DOMException("The operation was aborted", "AbortError"));
    }
    rejectFn = undefined;
  };

  const racePromise = new Promise<never>((_resolve, reject) => {
    rejectFn = reject;
  });

  signal.addEventListener("abort", doReject, { once: true });

  const cleanup = (): void => {
    signal.removeEventListener("abort", doReject);
    rejectFn = undefined;
    extraCleanup?.();
  };

  return { signal, racePromise, cleanup };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a caught error and re-throw appropriately.
 *
 * Only rewrites DOMException as KoiRuntimeError when the composed signal
 * actually fired — preventing misclassification of tool-originated
 * AbortError/TimeoutError (e.g., from fetch or browser APIs).
 */
function rethrowClassified(
  error: unknown,
  toolId: string,
  timeoutMs: number | undefined,
  composedSignal: AbortSignal | undefined,
): never {
  // Only classify DOMExceptions that came from OUR signal, not from the tool
  if (error instanceof DOMException && composedSignal?.aborted === true) {
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
  // Re-throw as-is — preserves error type for outer middleware
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

      // 3. Compose signal + timeout (returns undefined when no signal/timeout)
      const composed = createComposedSignal(request.signal, timeoutMs);

      if (composed !== undefined) {
        // 4. Build request with composed signal
        const forwardRequest: ToolRequest =
          composed.signal !== request.signal ? { ...request, signal: composed.signal } : request;

        // 5. Execute — race against signal, clean up timer + listener on all paths
        try {
          return await Promise.race([next(forwardRequest), composed.racePromise]);
        } catch (error: unknown) {
          rethrowClassified(error, request.toolId, timeoutMs, composed.signal);
        } finally {
          composed.cleanup();
        }
      }

      // No signal, no timeout — direct execution
      return next(request);
    },
  };
}
