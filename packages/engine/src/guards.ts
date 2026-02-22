/**
 * Engine guards — KoiMiddleware implementations for iteration limits,
 * loop detection, and spawn governance.
 *
 * Each guard is created by a factory function that closes over mutable state.
 * State is scoped to the middleware instance lifetime (one per session).
 */

import type { KoiMiddleware, ProcessAccounter } from "@koi/core";
import { fnv1a } from "@koi/core/hash";
import { KoiEngineError } from "./errors.js";
import type {
  IterationLimits,
  LoopDetectionConfig,
  LoopWarningInfo,
  SpawnPolicy,
} from "./types.js";
import { DEFAULT_ITERATION_LIMITS, DEFAULT_LOOP_DETECTION, DEFAULT_SPAWN_POLICY } from "./types.js";

export { fnv1a };

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
    priority: 0,

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
// Loop Detector — helpers
// ---------------------------------------------------------------------------

/** Compute fingerprint hash from a tool request. */
function computeFingerprint(toolId: string, input: unknown, maxKeys: number): number {
  const inputKeyCount =
    typeof input === "object" && input !== null
      ? Object.keys(input as Record<string, unknown>).length
      : 0;
  const fingerprint = inputKeyCount > maxKeys ? toolId : `${toolId}:${JSON.stringify(input)}`;
  return fnv1a(fingerprint);
}

/** Push hash into sliding window, evicting oldest if full. Returns the new count. */
function updateWindow(
  recentHashes: number[],
  counts: Map<number, number>,
  hash: number,
  windowSize: number,
): number {
  if (recentHashes.length >= windowSize) {
    const evicted = recentHashes.shift();
    if (evicted !== undefined) {
      const prev = counts.get(evicted) ?? 0;
      if (prev <= 1) {
        counts.delete(evicted);
      } else {
        counts.set(evicted, prev - 1);
      }
    }
  }
  recentHashes.push(hash);
  const newCount = (counts.get(hash) ?? 0) + 1;
  counts.set(hash, newCount);
  return newCount;
}

/** Check repeat-loop threshold and throw if exceeded. */
function checkRepeatLoop(
  toolId: string,
  newCount: number,
  threshold: number,
  windowSize: number,
): void {
  if (newCount >= threshold) {
    throw KoiEngineError.from(
      "VALIDATION",
      `Loop detected: tool "${toolId}" called with identical arguments ${newCount} times in last ${windowSize} calls`,
      {
        context: {
          toolId,
          repeatCount: newCount,
          windowSize,
          threshold,
          detectionKind: "repeat",
        },
      },
    );
  }
}

/**
 * Detect a repeating pattern in a hash sequence.
 *
 * Checks whether the tail of `hashes` consists of a repeating sub-sequence
 * of length `minPatternLength..floor(len/requiredRepetitions)`.
 *
 * @returns the detected pattern length, or 0 if no repeating pattern found.
 */
export function detectRepeatingPattern(
  hashes: readonly number[],
  minPatternLength: number,
  requiredRepetitions: number,
): number {
  const len = hashes.length;
  const maxPatternLength = Math.floor(len / requiredRepetitions);

  for (let patLen = minPatternLength; patLen <= maxPatternLength; patLen++) {
    const needed = patLen * requiredRepetitions;
    if (needed > len) continue;

    const start = len - needed;
    let matches = true;

    // Check that each repetition matches the first occurrence of the pattern
    for (let rep = 1; rep < requiredRepetitions && matches; rep++) {
      for (let i = 0; i < patLen; i++) {
        if (hashes[start + i] !== hashes[start + rep * patLen + i]) {
          matches = false;
          break;
        }
      }
    }

    if (matches) return patLen;
  }

  return 0;
}

/** Check for ping-pong (alternating/repeating pattern) and throw if detected. */
function checkPingPong(
  toolId: string,
  recentHashes: readonly number[],
  minPatternLength: number,
  requiredRepetitions: number,
): void {
  const patLen = detectRepeatingPattern(recentHashes, minPatternLength, requiredRepetitions);
  if (patLen > 0) {
    throw KoiEngineError.from(
      "VALIDATION",
      `Ping-pong loop detected: repeating pattern of length ${patLen} found after ${requiredRepetitions} repetitions (last tool: "${toolId}")`,
      {
        context: {
          toolId,
          patternLength: patLen,
          repetitions: requiredRepetitions,
          detectionKind: "ping_pong",
        },
      },
    );
  }
}

/** Check for no-progress (identical output) on a per-tool basis and throw if stalled. */
function checkNoProgress(
  toolId: string,
  outputHash: number,
  noProgressState: Map<string, { hash: number; count: number }>,
  noProgressThreshold: number,
): void {
  const prev = noProgressState.get(toolId);
  if (prev !== undefined && prev.hash === outputHash) {
    const newCount = prev.count + 1;
    noProgressState.set(toolId, { hash: outputHash, count: newCount });
    if (newCount >= noProgressThreshold) {
      throw KoiEngineError.from(
        "VALIDATION",
        `No-progress loop detected: tool "${toolId}" returned identical output ${newCount} consecutive times`,
        {
          context: {
            toolId,
            consecutiveCount: newCount,
            threshold: noProgressThreshold,
            detectionKind: "no_progress",
          },
        },
      );
    }
  } else {
    noProgressState.set(toolId, { hash: outputHash, count: 1 });
  }
}

// ---------------------------------------------------------------------------
// Loop Detector
// ---------------------------------------------------------------------------

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

  const recentHashes: number[] = [];
  const counts = new Map<number, number>();
  const firedWarnings = new Set<number>();
  const noProgressState = new Map<string, { hash: number; count: number }>();

  const pingPongEnabled = detection.pingPongEnabled ?? true;
  const pingPongMinPatternLength = detection.pingPongMinPatternLength ?? 2;
  const pingPongRepetitions = detection.pingPongRepetitions ?? 2;
  const noProgressEnabled = detection.noProgressEnabled ?? true;
  const noProgressThreshold = detection.noProgressThreshold ?? 3;
  const maxKeys = detection.maxInputKeys ?? 20;

  return {
    name: "koi:loop-detector",
    priority: 1,

    wrapToolCall: async (_ctx, request, next) => {
      const hash = computeFingerprint(request.toolId, request.input, maxKeys);
      const newCount = updateWindow(recentHashes, counts, hash, detection.windowSize);

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

      // Pre-call checks
      checkRepeatLoop(request.toolId, newCount, detection.threshold, detection.windowSize);

      if (pingPongEnabled) {
        checkPingPong(request.toolId, recentHashes, pingPongMinPatternLength, pingPongRepetitions);
      }

      // Execute the tool call
      const response = await next(request);

      // Post-call checks — hash output for no-progress detection.
      // Safely serialize output, skipping check on circular refs or very large outputs.
      if (noProgressEnabled) {
        let serialized: string | undefined;
        try {
          serialized = JSON.stringify(response.output);
        } catch {
          // Circular reference or non-serializable output — skip no-progress check
        }
        if (serialized !== undefined && serialized.length <= 65_536) {
          const outputHash = fnv1a(serialized);
          checkNoProgress(request.toolId, outputHash, noProgressState, noProgressThreshold);
        }
      }

      return response;
    },
  };
}

// ---------------------------------------------------------------------------
// Spawn Guard
// ---------------------------------------------------------------------------

export function createSpawnGuard(
  config?: Partial<SpawnPolicy>,
  agentDepth = 0,
  accounter?: ProcessAccounter,
): KoiMiddleware {
  const policy: SpawnPolicy = {
    ...DEFAULT_SPAWN_POLICY,
    ...config,
  };

  let activeProcesses = 1; // The current agent counts as 1 (local fallback)
  let directChildren = 0; // Tracks fan-out for this agent

  return {
    name: "koi:spawn-guard",
    priority: 2,

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

      // Check total process limit — use shared accounter if available, else local
      const totalActive = accounter !== undefined ? accounter.activeCount() : activeProcesses;
      if (totalActive >= policy.maxTotalProcesses) {
        throw KoiEngineError.from(
          "PERMISSION",
          `Max total processes exceeded: ${totalActive}/${policy.maxTotalProcesses}`,
          {
            context: { activeProcesses: totalActive, maxTotalProcesses: policy.maxTotalProcesses },
          },
        );
      }

      const response = await next(request);

      if (accounter !== undefined) {
        accounter.increment();
      } else {
        activeProcesses++;
      }
      directChildren++;
      return response;
    },
  };
}
