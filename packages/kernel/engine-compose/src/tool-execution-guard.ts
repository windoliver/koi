/**
 * Tool execution guard — per-call abort propagation and timeout enforcement.
 *
 * Auto-enabled by createDefaultGuardExtension alongside iteration, loop, and
 * spawn guards. Wraps every tool call with:
 * - Abort signal composition (parent + per-call timeout)
 * - Per-tool timeout enforcement via Promise.race
 * - Pre-aborted signal short-circuit
 *
 * Errors are thrown as KoiRuntimeError (for timeout/abort) or re-thrown as-is
 * (for tool failures). Error-to-ToolResponse normalization is the engine
 * adapter's responsibility at the outermost boundary.
 */

import type { KoiMiddleware, ToolRequest } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import type { ToolExecutionConfig } from "./guard-types.js";

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

function validateToolExecutionConfig(config: ToolExecutionConfig): void {
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

interface ComposedSignal {
  readonly signal: AbortSignal;
  readonly racePromise: Promise<never>;
  readonly isOurTimeout: () => boolean;
  readonly cleanup: () => void;
}

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

function createComposedSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): ComposedSignal | undefined {
  if (timeoutMs === undefined && parentSignal === undefined) {
    return undefined;
  }

  const controller = new AbortController();

  // Parent signal forwarding (fully cleanable)
  let parentListener: (() => void) | undefined;
  if (parentSignal !== undefined) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentListener = () => {
        controller.abort(parentSignal.reason);
      };
      parentSignal.addEventListener("abort", parentListener, { once: true });
    }
  }

  // Timeout timer (fully cleanable)
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined && !controller.signal.aborted) {
    timer = setTimeout(() => {
      controller.abort(createTimeoutReason(timeoutMs));
    }, timeoutMs);
  }

  // Race promise
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
      rejectFn(new DOMException(String(reason ?? "aborted"), "AbortError"));
    }
    rejectFn = undefined;
  };

  if (controller.signal.aborted) {
    doReject();
  } else {
    controller.signal.addEventListener("abort", doReject, { once: true });
  }

  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (parentListener !== undefined && parentSignal !== undefined) {
      parentSignal.removeEventListener("abort", parentListener);
    }
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

function rethrowClassified(
  error: unknown,
  toolId: string,
  composed: ComposedSignal | undefined,
): never {
  if (error instanceof DOMException && composed?.signal.aborted === true) {
    if (composed.isOurTimeout()) {
      const reason = composed.signal.reason as TimeoutAbortReason;
      throw KoiRuntimeError.from(
        "EXTERNAL",
        `Tool "${toolId}" timed out after ${reason.timeoutMs}ms`,
        { retryable: false, context: { toolId, timeoutMs: reason.timeoutMs } },
      );
    }
    const abortReason = String(composed.signal.reason ?? "aborted");
    throw KoiRuntimeError.from("INTERNAL", `Tool "${toolId}" interrupted: ${abortReason}`, {
      retryable: false,
      context: { toolId, abortReason },
    });
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a tool-execution guard middleware. */
export function createToolExecutionGuard(config?: Partial<ToolExecutionConfig>): KoiMiddleware {
  if (config !== undefined) {
    validateToolExecutionConfig(config);
  }

  const defaultTimeoutMs = config?.defaultTimeoutMs;
  const toolTimeouts: ReadonlyMap<string, number> =
    config?.toolTimeouts !== undefined ? new Map(Object.entries(config.toolTimeouts)) : new Map();

  return {
    name: "koi:tool-execution",
    priority: 100,
    phase: "resolve",
    describeCapabilities: () => undefined,

    wrapToolCall: async (_ctx, request, next) => {
      if (request.signal?.aborted === true) {
        const abortReason = String(request.signal.reason ?? "aborted");
        throw KoiRuntimeError.from(
          "INTERNAL",
          `Tool "${request.toolId}" interrupted: ${abortReason}`,
          { retryable: false, context: { toolId: request.toolId, abortReason } },
        );
      }

      const timeoutMs = resolveTimeoutMs(request.toolId, toolTimeouts, defaultTimeoutMs);
      const composed = createComposedSignal(request.signal, timeoutMs);

      if (composed !== undefined) {
        const forwardRequest: ToolRequest =
          composed.signal !== request.signal ? { ...request, signal: composed.signal } : request;

        try {
          return await Promise.race([next(forwardRequest), composed.racePromise]);
        } catch (error: unknown) {
          rethrowClassified(error, request.toolId, composed);
        } finally {
          composed.cleanup();
        }
      }

      return next(request);
    },
  };
}
