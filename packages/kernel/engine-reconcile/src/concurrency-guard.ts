/**
 * Concurrency guard — KoiMiddleware that limits concurrent model/tool calls
 * across all agents sharing the same guard instance.
 *
 * Uses a counting semaphore per call kind (model / tool). Shared across sessions
 * so that a single `createConcurrencyGuard()` instance gates all agents that
 * reference it, preventing rate-limit hits and memory spikes.
 */

import type { KoiMiddleware, ModelRequest } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import type { ConcurrencySemaphore } from "./concurrency-semaphore.js";
import { createConcurrencySemaphore } from "./concurrency-semaphore.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ConcurrencyGuardConfig {
  readonly maxConcurrentModelCalls: number;
  readonly maxConcurrentToolCalls: number;
  readonly acquireTimeoutMs: number;
}

export const DEFAULT_CONCURRENCY_GUARD_CONFIG: ConcurrencyGuardConfig = {
  maxConcurrentModelCalls: 5,
  maxConcurrentToolCalls: 10,
  acquireTimeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createConcurrencyGuard(config?: Partial<ConcurrencyGuardConfig>): KoiMiddleware {
  const resolved: ConcurrencyGuardConfig = {
    ...DEFAULT_CONCURRENCY_GUARD_CONFIG,
    ...config,
  };

  if (!Number.isFinite(resolved.acquireTimeoutMs) || resolved.acquireTimeoutMs <= 0) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `acquireTimeoutMs must be a positive number, got ${String(resolved.acquireTimeoutMs)}`,
      { context: { acquireTimeoutMs: resolved.acquireTimeoutMs } },
    );
  }

  const modelSem: ConcurrencySemaphore = createConcurrencySemaphore(
    resolved.maxConcurrentModelCalls,
  );
  const toolSem: ConcurrencySemaphore = createConcurrencySemaphore(resolved.maxConcurrentToolCalls);

  function acquireOrThrow(
    sem: ConcurrencySemaphore,
    kind: "model" | "tool",
    maxConcurrency: number,
  ): Promise<void> {
    return sem.acquire(resolved.acquireTimeoutMs).catch((cause: unknown) => {
      throw KoiRuntimeError.from(
        "TIMEOUT",
        `Concurrency guard: timed out waiting for ${kind} slot ` +
          `(${sem.activeCount()}/${maxConcurrency} active, ${resolved.acquireTimeoutMs}ms timeout)`,
        {
          retryable: true,
          cause,
          context: {
            kind,
            activeCount: sem.activeCount(),
            maxConcurrency,
            acquireTimeoutMs: resolved.acquireTimeoutMs,
          },
        },
      );
    });
  }

  return {
    name: "koi:concurrency-guard",
    priority: 3,

    describeCapabilities: (_ctx) => ({
      label: "Concurrency Guard",
      description:
        `Limits concurrent calls: model ${modelSem.activeCount()}/${resolved.maxConcurrentModelCalls}, ` +
        `tool ${toolSem.activeCount()}/${resolved.maxConcurrentToolCalls}`,
    }),

    wrapModelCall: async (_ctx, request, next) => {
      await acquireOrThrow(modelSem, "model", resolved.maxConcurrentModelCalls);
      try {
        return await next(request);
      } finally {
        modelSem.release();
      }
    },

    wrapModelStream: (_ctx, request: ModelRequest, next) => ({
      async *[Symbol.asyncIterator]() {
        await acquireOrThrow(modelSem, "model", resolved.maxConcurrentModelCalls);
        try {
          for await (const chunk of next(request)) {
            yield chunk;
          }
        } finally {
          modelSem.release();
        }
      },
    }),

    wrapToolCall: async (_ctx, request, next) => {
      await acquireOrThrow(toolSem, "tool", resolved.maxConcurrentToolCalls);
      try {
        return await next(request);
      } finally {
        toolSem.release();
      }
    },
  };
}
