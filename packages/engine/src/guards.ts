/**
 * Engine guards — KoiMiddleware implementations for iteration limits,
 * loop detection, and spawn governance.
 *
 * Each guard is created by a factory function that closes over mutable state.
 * State is scoped to the middleware instance lifetime (one per session).
 */

import type { Agent, GovernanceComponent, KoiMiddleware, SpawnLedger } from "@koi/core";
import { GOVERNANCE } from "@koi/core";
import { fnv1a } from "@koi/hash";
import { KoiEngineError } from "./errors.js";
import { createInMemorySpawnLedger } from "./spawn-ledger.js";
import type {
  IterationLimits,
  LoopDetectionConfig,
  LoopWarningInfo,
  SpawnPolicy,
} from "./types.js";
import {
  DEFAULT_ITERATION_LIMITS,
  DEFAULT_LOOP_DETECTION,
  DEFAULT_SPAWN_POLICY,
  DEFAULT_SPAWN_TOOL_IDS,
} from "./types.js";

export { fnv1a };

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

/**
 * Build a shallow fingerprint of a tool call without JSON.stringify.
 * Hashes toolId + top-level keys and shallow string values (capped at 128 chars).
 * O(keys) instead of O(input_size).
 *
 * When maxKeys is provided and the input exceeds it, falls back to
 * toolId-only fingerprinting to avoid hashing extremely wide objects.
 */
function shallowToolFingerprint(toolId: string, input: unknown, maxKeys?: number): number {
  let hash = fnv1a(toolId);
  if (typeof input === "object" && input !== null) {
    const keys = Object.keys(input).sort();
    if (maxKeys !== undefined && keys.length > maxKeys) {
      // Fall back to toolId-only fingerprint for very large inputs
      return hash >>> 0;
    }
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
  buf: readonly number[],
  cursor: number,
  filled: number,
  minPatternLength: number,
  requiredRepetitions: number,
): void {
  const patLen = detectRepeatingPatternInRing(
    buf,
    cursor,
    filled,
    minPatternLength,
    requiredRepetitions,
  );
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

/**
 * Access ring buffer by logical index (0 = oldest, count-1 = newest).
 * Zero allocation — translates logical index to physical position.
 */
function ringAt(
  buf: readonly number[],
  cursor: number,
  filled: number,
  logicalIndex: number,
): number {
  const start = filled < buf.length ? 0 : cursor;
  // biome-ignore lint/style/noNonNullAssertion: index is always within bounds (modular arithmetic over buf.length)
  return buf[(start + logicalIndex) % buf.length]!;
}

/**
 * Detect repeating pattern directly in ring buffer without snapshot allocation.
 * Same algorithm as detectRepeatingPattern but reads via ring buffer accessor.
 */
function detectRepeatingPatternInRing(
  buf: readonly number[],
  cursor: number,
  filled: number,
  minPatternLength: number,
  requiredRepetitions: number,
): number {
  const len = filled;
  const maxPatternLength = Math.floor(len / requiredRepetitions);

  for (let patLen = minPatternLength; patLen <= maxPatternLength; patLen++) {
    const needed = patLen * requiredRepetitions;
    if (needed > len) continue;

    const start = len - needed;
    let matches = true;

    for (let rep = 1; rep < requiredRepetitions && matches; rep++) {
      for (let i = 0; i < patLen; i++) {
        if (
          ringAt(buf, cursor, filled, start + i) !==
          ringAt(buf, cursor, filled, start + rep * patLen + i)
        ) {
          matches = false;
          break;
        }
      }
    }

    if (matches) return patLen;
  }

  return 0;
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

  // Circular buffer for O(1) insert + evict
  const ringBuffer = new Array<number>(detection.windowSize).fill(0);
  // let justified: mutable write cursor and fill count for circular buffer
  let cursor = 0;
  let filled = 0;

  // Persistent frequency map — updated incrementally, O(1) per call
  const hashCounts = new Map<number, number>();
  /** Tracks hashes that have already fired a warning (at most once per unique hash). */
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
      const hash = shallowToolFingerprint(request.toolId, request.input, maxKeys);

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

      // Pre-call checks
      checkRepeatLoop(request.toolId, newCount, detection.threshold, detection.windowSize);

      if (pingPongEnabled) {
        checkPingPong(
          request.toolId,
          ringBuffer,
          cursor,
          filled,
          pingPongMinPatternLength,
          pingPongRepetitions,
        );
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

/**
 * Options for creating a spawn guard middleware.
 */
export interface CreateSpawnGuardOptions {
  /** Spawn governance policy. Merged with DEFAULT_SPAWN_POLICY. */
  readonly policy?: Partial<SpawnPolicy>;
  /** Depth of the current agent in the process tree (0 = root). */
  readonly agentDepth?: number;
  /** Shared spawn ledger for tree-wide concurrency tracking. */
  readonly ledger?: SpawnLedger;
  /** Agent entity — if present, GovernanceComponent will be consulted. */
  readonly agent?: Agent;
}

export function createSpawnGuard(options?: CreateSpawnGuardOptions): KoiMiddleware {
  const { policy: configOverrides, agentDepth = 0, agent } = options ?? {};

  const policy: SpawnPolicy = {
    ...DEFAULT_SPAWN_POLICY,
    ...configOverrides,
  };

  // Validate warning thresholds at construction time
  if (policy.fanOutWarningAt !== undefined && policy.fanOutWarningAt >= policy.maxFanOut) {
    throw KoiEngineError.from(
      "VALIDATION",
      `fanOutWarningAt (${policy.fanOutWarningAt}) must be less than maxFanOut (${policy.maxFanOut})`,
      {
        context: {
          fanOutWarningAt: policy.fanOutWarningAt,
          maxFanOut: policy.maxFanOut,
        },
      },
    );
  }

  if (
    policy.totalProcessWarningAt !== undefined &&
    policy.totalProcessWarningAt >= policy.maxTotalProcesses
  ) {
    throw KoiEngineError.from(
      "VALIDATION",
      `totalProcessWarningAt (${policy.totalProcessWarningAt}) must be less than maxTotalProcesses (${policy.maxTotalProcesses})`,
      {
        context: {
          totalProcessWarningAt: policy.totalProcessWarningAt,
          maxTotalProcesses: policy.maxTotalProcesses,
        },
      },
    );
  }

  // Build spawn tool ID set for O(1) lookup
  const spawnToolIds = new Set<string>(policy.spawnToolIds ?? DEFAULT_SPAWN_TOOL_IDS);

  // Shared ledger — use provided or create in-memory default
  const ledger: SpawnLedger =
    options?.ledger ?? createInMemorySpawnLedger(policy.maxTotalProcesses);

  // Cache GovernanceComponent lookup — fixed after assembly, no need to look up per-call
  const governance = agent?.component<GovernanceComponent>(GOVERNANCE);

  // let justified: mutable per-agent fan-out counter
  let directChildren = 0;

  // let justified: mutable flags to fire warnings at most once per kind
  let firedFanOutWarning = false;
  let firedTotalWarning = false;

  return {
    name: "koi:spawn-guard",
    priority: 2,

    wrapToolCall: async (_ctx, request, next) => {
      // Early return for non-spawn tools (hot path — O(1) set lookup)
      if (!spawnToolIds.has(request.toolId)) {
        return next(request);
      }

      // 1. Check depth (structural, PERMISSION — not retryable)
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

      // 2. Consult GovernanceComponent (cached at construction)
      if (governance !== undefined) {
        const check = governance.checkSpawn(childDepth);
        if (!check.allowed) {
          throw KoiEngineError.from("PERMISSION", check.reason, {
            context: { childDepth, source: "GovernanceComponent" },
          });
        }
      }

      // 3. Check fan-out (transient, RATE_LIMIT — retryable when child completes)
      if (directChildren >= policy.maxFanOut) {
        throw KoiEngineError.from(
          "RATE_LIMIT",
          `Max fan-out exceeded: ${directChildren}/${policy.maxFanOut} children`,
          {
            retryable: true,
            context: { directChildren, maxFanOut: policy.maxFanOut },
          },
        );
      }

      // 4. Optimistic: increment fan-out before next()
      directChildren++;

      // 5. Acquire ledger slot (total processes)
      const acquired = await ledger.acquire();
      if (!acquired) {
        // Rollback fan-out
        directChildren--;
        const active = ledger.activeCount();
        const cap = ledger.capacity();
        throw KoiEngineError.from("RATE_LIMIT", `Max total processes exceeded: ${active}/${cap}`, {
          retryable: true,
          context: { activeProcesses: active, maxTotalProcesses: cap },
        });
      }

      // 6. Fire warnings (synchronous, at most once per kind)
      if (
        !firedFanOutWarning &&
        policy.fanOutWarningAt !== undefined &&
        policy.onWarning !== undefined &&
        directChildren >= policy.fanOutWarningAt
      ) {
        firedFanOutWarning = true;
        policy.onWarning({
          kind: "fan_out",
          current: directChildren,
          limit: policy.maxFanOut,
          warningAt: policy.fanOutWarningAt,
        });
      }

      const currentActive = ledger.activeCount();
      if (
        !firedTotalWarning &&
        policy.totalProcessWarningAt !== undefined &&
        policy.onWarning !== undefined &&
        currentActive >= policy.totalProcessWarningAt
      ) {
        firedTotalWarning = true;
        policy.onWarning({
          kind: "total_processes",
          current: currentActive,
          limit: ledger.capacity(),
          warningAt: policy.totalProcessWarningAt,
        });
      }

      // 7. Execute spawn — release slots when child completes (success or failure)
      try {
        return await next(request);
      } finally {
        directChildren--;
        await ledger.release();
      }
    },
  };
}
