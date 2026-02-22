/**
 * Engine guards — KoiMiddleware implementations for iteration limits,
 * loop detection, and spawn governance.
 *
 * Each guard is created by a factory function that closes over mutable state.
 * State is scoped to the middleware instance lifetime (one per session).
 */

import type { KoiMiddleware } from "@koi/core";
import { KoiEngineError } from "./errors.js";
import type { IterationLimits, LoopDetectionConfig, SpawnPolicy } from "./types.js";
import { DEFAULT_ITERATION_LIMITS, DEFAULT_LOOP_DETECTION, DEFAULT_SPAWN_POLICY } from "./types.js";

// ---------------------------------------------------------------------------
// FNV-1a hash (32-bit)
// ---------------------------------------------------------------------------

export function fnv1a(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Iteration Guard
// ---------------------------------------------------------------------------

export function createIterationGuard(config?: Partial<IterationLimits>): KoiMiddleware {
  const limits: IterationLimits = {
    ...DEFAULT_ITERATION_LIMITS,
    ...config,
  };

  let turns = 0;
  let totalTokens = 0;
  const startedAt = Date.now();

  function checkLimits(): void {
    if (turns >= limits.maxTurns) {
      throw KoiEngineError.from("TIMEOUT", `Max turns exceeded: ${turns}/${limits.maxTurns}`, {
        context: { turns, maxTurns: limits.maxTurns },
      });
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= limits.maxDurationMs) {
      throw KoiEngineError.from(
        "TIMEOUT",
        `Duration limit exceeded: ${elapsed}ms/${limits.maxDurationMs}ms`,
        {
          context: { elapsedMs: elapsed, maxDurationMs: limits.maxDurationMs },
        },
      );
    }

    if (totalTokens >= limits.maxTokens) {
      throw KoiEngineError.from(
        "TIMEOUT",
        `Token budget exhausted: ${totalTokens}/${limits.maxTokens}`,
        {
          context: { totalTokens, maxTokens: limits.maxTokens },
        },
      );
    }
  }

  function trackUsage(inputTokens: number, outputTokens: number): void {
    turns++;
    totalTokens += inputTokens + outputTokens;
  }

  return {
    name: "koi:iteration-guard",

    wrapModelCall: async (_ctx, request, next) => {
      checkLimits();

      const response = await next(request);

      trackUsage(response.usage?.inputTokens ?? 0, response.usage?.outputTokens ?? 0);

      return response;
    },

    wrapModelStream: (_ctx, request, next) => {
      checkLimits();

      return {
        async *[Symbol.asyncIterator]() {
          for await (const chunk of next(request)) {
            yield chunk;
            if (chunk.kind === "done") {
              trackUsage(
                chunk.response.usage?.inputTokens ?? 0,
                chunk.response.usage?.outputTokens ?? 0,
              );
            }
          }
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Loop Detector
// ---------------------------------------------------------------------------

export function createLoopDetector(config?: Partial<LoopDetectionConfig>): KoiMiddleware {
  const detection: LoopDetectionConfig = {
    ...DEFAULT_LOOP_DETECTION,
    ...config,
  };

  const recentHashes: number[] = [];

  return {
    name: "koi:loop-detector",

    wrapToolCall: async (_ctx, request, next) => {
      // Hash the tool call signature: toolId + serialized input
      const fingerprint = `${request.toolId}:${JSON.stringify(request.input)}`;
      const hash = fnv1a(fingerprint);

      // Add to window
      recentHashes.push(hash);
      if (recentHashes.length > detection.windowSize) {
        recentHashes.shift();
      }

      // Check for repeated hashes in the window
      const counts = new Map<number, number>();
      for (const h of recentHashes) {
        const count = (counts.get(h) ?? 0) + 1;
        counts.set(h, count);
        if (count >= detection.threshold) {
          throw KoiEngineError.from(
            "VALIDATION",
            `Loop detected: tool "${request.toolId}" called with identical arguments ${count} times in last ${detection.windowSize} calls`,
            {
              context: {
                toolId: request.toolId,
                repeatCount: count,
                windowSize: detection.windowSize,
                threshold: detection.threshold,
              },
            },
          );
        }
      }

      return next(request);
    },
  };
}

// ---------------------------------------------------------------------------
// Spawn Guard
// ---------------------------------------------------------------------------

export function createSpawnGuard(config?: Partial<SpawnPolicy>, agentDepth = 0): KoiMiddleware {
  const policy: SpawnPolicy = {
    ...DEFAULT_SPAWN_POLICY,
    ...config,
  };

  let activeProcesses = 1; // The current agent counts as 1
  let directChildren = 0; // Tracks fan-out for this agent

  return {
    name: "koi:spawn-guard",

    wrapToolCall: async (_ctx, request, next) => {
      // Only intercept spawn-related tool calls
      if (request.toolId !== "forge_agent") {
        return next(request);
      }

      // Check depth limit — child would be at agentDepth + 1
      const childDepth = agentDepth + 1;
      if (childDepth > policy.maxDepth) {
        throw KoiEngineError.from(
          "PERMISSION",
          `Max spawn depth exceeded: child would be at depth ${childDepth}, limit is ${policy.maxDepth}`,
          {
            context: { agentDepth, childDepth, maxDepth: policy.maxDepth },
          },
        );
      }

      // Check fan-out limit
      if (directChildren >= policy.maxFanOut) {
        throw KoiEngineError.from(
          "PERMISSION",
          `Max fan-out exceeded: ${directChildren}/${policy.maxFanOut} children`,
          {
            context: { directChildren, maxFanOut: policy.maxFanOut },
          },
        );
      }

      // Check total process limit
      if (activeProcesses >= policy.maxTotalProcesses) {
        throw KoiEngineError.from(
          "PERMISSION",
          `Max total processes exceeded: ${activeProcesses}/${policy.maxTotalProcesses}`,
          {
            context: { activeProcesses, maxTotalProcesses: policy.maxTotalProcesses },
          },
        );
      }

      const response = await next(request);
      activeProcesses++;
      directChildren++;
      return response;
    },
  };
}
