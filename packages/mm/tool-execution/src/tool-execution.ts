/**
 * Per-call tool execution middleware factory.
 *
 * Wraps every tool call with:
 * - Abort signal composition (parent + per-call timeout)
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
// Timeout resolution
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

// ---------------------------------------------------------------------------
// Signal composition with full cleanup
// ---------------------------------------------------------------------------

/**
 * Composed signal result. The caller MUST invoke cleanup() in a finally block
 * to clear the timeout timer and remove all listeners — prevents timer leaks,
 * listener accumulation, and AbortSignal.any() subscription leaks.
 */
interface ComposedSignal {
  readonly signal: AbortSignal;
  /** Racing promise that rejects when the signal fires. */
  readonly racePromise: Promise<never>;
  /** Whether the abort was caused by our timeout (true) or by the parent signal (false). */
  readonly isOurTimeout: () => boolean;
  /** Clear timer + remove all listeners. MUST be called in finally. */
  readonly cleanup: () => void;
}

/**
 * Sentinel reason used to tag our timeout abort. Allows distinguishing
 * "our timer fired" from "parent signal fired" when both share a controller.
 */
const TIMEOUT_SENTINEL = Symbol("koi:tool-execution:timeout");

interface TimeoutAbortReason {
  readonly __brand: typeof TIMEOUT_SENTINEL;
  readonly timeoutMs: number;
}

function createTimeoutReason(timeoutMs: number): TimeoutAbortReason {
  return { __brand: TIMEOUT_SENTINEL, timeoutMs };
}

function isTimeoutReason(reason: unknown): reason is TimeoutAbortReason {
  return (
    typeof reason === "object" &&
    reason !== null &&
    "__brand" in reason &&
    (reason as Record<string, unknown>).__brand === TIMEOUT_SENTINEL
  );
}

/**
 * Build a composed signal that merges a parent signal with a per-call timeout.
 * Uses a single AbortController with manual parent-signal forwarding instead
 * of AbortSignal.any() — so all subscriptions can be fully cleaned up.
 *
 * Returns undefined when neither parent signal nor timeout exist.
 */
function createComposedSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): ComposedSignal | undefined {
  if (timeoutMs === undefined && parentSignal === undefined) {
    return undefined;
  }

  const controller = new AbortController();

  // --- Parent signal forwarding (fully cleanable) ---
  let parentListener: (() => void) | undefined;
  if (parentSignal !== undefined) {
    // If parent already aborted, abort immediately with its reason
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentListener = () => {
        controller.abort(parentSignal.reason);
      };
      parentSignal.addEventListener("abort", parentListener, { once: true });
    }
  }

  // --- Timeout timer (fully cleanable) ---
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined && !controller.signal.aborted) {
    timer = setTimeout(() => {
      controller.abort(createTimeoutReason(timeoutMs));
    }, timeoutMs);
  }

  // --- Race promise ---
  // let justified: mutable binding swapped by doReject/cleanup
  let rejectFn: ((reason: unknown) => void) | undefined;

  const racePromise = new Promise<never>((_resolve, reject) => {
    rejectFn = reject;
  });

  const doReject = (): void => {
    if (rejectFn === undefined) return;
    const reason: unknown = controller.signal.reason;
    if (isTimeoutReason(reason)) {
      rejectFn(new DOMException("The operation timed out", "TimeoutError"));
    } else if (reason instanceof DOMException) {
      rejectFn(reason);
    } else {
      // Preserve the original abort reason (e.g., "user_cancel", "shutdown")
      rejectFn(new DOMException(String(reason ?? "aborted"), "AbortError"));
    }
    rejectFn = undefined;
  };

  if (controller.signal.aborted) {
    // Already aborted (parent was pre-aborted) — reject immediately
    doReject();
  } else {
    controller.signal.addEventListener("abort", doReject, { once: true });
  }

  const cleanup = (): void => {
    // Clear timeout timer
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    // Remove parent forwarding listener (prevents AbortSignal.any()-style leaks)
    if (parentListener !== undefined && parentSignal !== undefined) {
      parentSignal.removeEventListener("abort", parentListener);
    }
    // Remove race listener from our controller's signal
    controller.signal.removeEventListener("abort", doReject);
    rejectFn = undefined;
  };

  return {
    signal: controller.signal,
    racePromise,
    isOurTimeout: () => isTimeoutReason(controller.signal.reason),
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a caught error and re-throw appropriately.
 *
 * - Our timeout → KoiRuntimeError("TIMEOUT") with retryable: false
 * - External cancellation (user_cancel, shutdown, etc.) → re-thrown as-is
 *   to preserve the abort reason for upstream middleware
 * - Tool-originated errors → re-thrown as-is
 *
 * Only classifies DOMExceptions when the composed signal actually fired
 * AND the abort was our timeout — preventing misclassification of
 * tool-originated or parent-originated aborts.
 */
function rethrowClassified(
  error: unknown,
  toolId: string,
  composed: ComposedSignal | undefined,
): never {
  // Only classify as TIMEOUT when our timer caused the abort
  if (
    error instanceof DOMException &&
    composed?.signal.aborted === true &&
    composed.isOurTimeout()
  ) {
    const reason = composed.signal.reason as TimeoutAbortReason;
    throw KoiRuntimeError.from(
      "TIMEOUT",
      `Tool "${toolId}" timed out after ${reason.timeoutMs}ms`,
      {
        retryable: false,
        context: { toolId, timeoutMs: reason.timeoutMs },
      },
    );
  }
  // Everything else (tool errors, parent aborts) re-thrown as-is
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
        // Re-throw as DOMException preserving the original reason — do NOT
        // collapse into TIMEOUT. Upstream middleware inspects signal.reason
        // to distinguish user_cancel/shutdown/token_limit from timeout.
        throw new DOMException(String(request.signal.reason ?? "aborted"), "AbortError");
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
          rethrowClassified(error, request.toolId, composed);
        } finally {
          composed.cleanup();
        }
      }

      // No signal, no timeout — direct execution
      return next(request);
    },
  };
}
