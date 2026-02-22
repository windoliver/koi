/**
 * Engine guards — KoiMiddleware implementations for iteration limits,
 * loop detection, and spawn governance.
 *
 * Each guard is created by a factory function that closes over mutable state.
 * State is scoped to the middleware instance lifetime (one per session).
 */

import type { KoiMiddleware } from "@koi/core";
import { KoiEngineError } from "./errors.js";
import type {
  IterationLimits,
  LoopDetectionConfig,
  LoopWarningInfo,
  SpawnPolicy,
} from "./types.js";
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

  // let justified: mutable counters scoped to this middleware instance lifetime
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

/**
 * Build a shallow fingerprint of a tool call without JSON.stringify.
 * Hashes toolId + top-level keys and shallow string values (capped at 128 chars).
 * O(keys) instead of O(input_size).
 */
function shallowToolFingerprint(toolId: string, input: unknown): number {
  let hash = fnv1a(toolId);
  if (typeof input === "object" && input !== null) {
    const keys = Object.keys(input).sort();
    for (const key of keys) {
      hash ^= fnv1a(key);
      hash = Math.imul(hash, 0x01000193);
      const value = (input as Record<string, unknown>)[key];
      const repr =
        typeof value === "string"
          ? value.slice(0, 128)
          : `${typeof value}:${String(value).slice(0, 64)}`;
      hash ^= fnv1a(repr);
      hash = Math.imul(hash, 0x01000193);
    }
  } else {
    hash ^= fnv1a(String(input));
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createLoopDetector(config?: Partial<LoopDetectionConfig>): KoiMiddleware {
  const detection: LoopDetectionConfig = {
    ...DEFAULT_LOOP_DETECTION,
    ...config,
  };

  // Validate: warningThreshold must be strictly less than threshold
  if (
    detection.warningThreshold !== undefined &&
    detection.warningThreshold >= detection.threshold
  ) {
    throw KoiEngineError.from(
      "VALIDATION",
      `warningThreshold (${detection.warningThreshold}) must be less than threshold (${detection.threshold})`,
      {
        context: {
          warningThreshold: detection.warningThreshold,
          threshold: detection.threshold,
        },
      },
    );
  }

  // Circular buffer for O(1) insert + evict
  const ringBuffer = new Array<number>(detection.windowSize).fill(0);
  // let justified: mutable write cursor and fill count for circular buffer
  let cursor = 0;
  let filled = 0;

  // Persistent frequency map — updated incrementally, O(1) per call
  const hashCounts = new Map<number, number>();
  /** Tracks hashes that have already fired a warning (at most once per unique hash). */
  const firedWarnings = new Set<number>();

  return {
    name: "koi:loop-detector",

    wrapToolCall: async (_ctx, request, next) => {
      const hash = shallowToolFingerprint(request.toolId, request.input);

      // Evict the oldest entry if the buffer is full
      if (filled >= detection.windowSize) {
        const evicted = ringBuffer[cursor] as number;
        const oldCount = hashCounts.get(evicted) ?? 0;
        if (oldCount <= 1) {
          hashCounts.delete(evicted);
        } else {
          hashCounts.set(evicted, oldCount - 1);
        }
      }

      // Insert new hash into circular buffer
      ringBuffer[cursor] = hash;
      cursor = (cursor + 1) % detection.windowSize;
      filled = Math.min(filled + 1, detection.windowSize);

      // Increment count for new hash
      const newCount = (hashCounts.get(hash) ?? 0) + 1;
      hashCounts.set(hash, newCount);

      // Warning check — fires at most once per unique hash
      if (
        detection.warningThreshold !== undefined &&
        detection.onWarning !== undefined &&
        newCount >= detection.warningThreshold &&
        !firedWarnings.has(hash)
      ) {
        firedWarnings.add(hash);
        const info: LoopWarningInfo = {
          toolId: request.toolId,
          repeatCount: newCount,
          windowSize: detection.windowSize,
          warningThreshold: detection.warningThreshold,
          threshold: detection.threshold,
        };
        detection.onWarning(info);
      }

      // Check threshold
      if (newCount >= detection.threshold) {
        throw KoiEngineError.from(
          "VALIDATION",
          `Loop detected: tool "${request.toolId}" called with identical arguments ${newCount} times in last ${detection.windowSize} calls`,
          {
            context: {
              toolId: request.toolId,
              repeatCount: newCount,
              windowSize: detection.windowSize,
              threshold: detection.threshold,
            },
          },
        );
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

  // let justified: mutable counters scoped to this middleware instance lifetime
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
