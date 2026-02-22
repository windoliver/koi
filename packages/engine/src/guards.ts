/**
 * Engine guards — KoiMiddleware implementations for iteration limits,
 * loop detection, and spawn governance.
 *
 * Each guard is created by a factory function that closes over mutable state.
 * State is scoped to the middleware instance lifetime (one per session).
 */

import type {
  Agent,
  GovernanceComponent,
  InboundMessage,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  SpawnLedger,
  TurnContext,
} from "@koi/core";
import { GOVERNANCE } from "@koi/core";
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

// ---------------------------------------------------------------------------
// Shared validation helper
// ---------------------------------------------------------------------------

/**
 * Validates that a warning threshold is strictly less than its corresponding
 * hard limit. Throws VALIDATION error if the invariant is violated.
 */
function validateWarningThreshold(
  warningName: string,
  warningValue: number | undefined,
  limitName: string,
  limitValue: number,
): void {
  if (warningValue !== undefined && warningValue >= limitValue) {
    throw KoiEngineError.from(
      "VALIDATION",
      `${warningName} (${warningValue}) must be less than ${limitName} (${limitValue})`,
      { context: { [warningName]: warningValue, [limitName]: limitValue } },
    );
  }
}

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

  validateWarningThreshold(
    "warningThreshold",
    detection.warningThreshold,
    "threshold",
    detection.threshold,
  );

  // Circular buffer for O(1) insert + evict
  const ringBuffer = new Array<number>(detection.windowSize).fill(0);
  // let justified: mutable write cursor and fill count for circular buffer
  let cursor = 0;
  let filled = 0;

  // Persistent frequency map — updated incrementally, O(1) per call
  const hashCounts = new Map<number, number>();
  /** Tracks hashes that have already fired a warning (at most once per unique hash). */
  const firedWarnings = new Set<number>();

  /** Queued warnings to inject into the next model call. */
  // let justified: mutable binding swapped on each injection cycle
  let pendingWarnings: readonly LoopWarningInfo[] = [];

  // Both conditions required: injectWarning must not be explicitly disabled,
  // AND warningThreshold must be set (otherwise no warnings are ever generated).
  const shouldInject =
    detection.injectWarning !== false && detection.warningThreshold !== undefined;

  /**
   * Build an InboundMessage from queued warnings and prepend to request.messages.
   * Follows the same pattern as middleware-memory (senderId: "system:loop-detector").
   */
  function buildEnrichedRequest(request: ModelRequest): ModelRequest {
    if (pendingWarnings.length === 0) {
      return request;
    }

    const current = pendingWarnings;
    pendingWarnings = [];

    const lines = current.map(
      (w) =>
        `WARNING: Tool "${w.toolId}" has been called ${w.repeatCount} times with identical arguments` +
        ` in the last ${w.windowSize} calls. Hard limit is ${w.threshold} repetitions.` +
        ` You MUST try a different approach or your execution will be terminated.`,
    );

    const warningMessage: InboundMessage = {
      senderId: "system:loop-detector",
      timestamp: Date.now(),
      content: [{ kind: "text", text: lines.join("\n") }],
    };

    return {
      ...request,
      messages: [warningMessage, ...request.messages],
    };
  }

  return {
    name: "koi:loop-detector",

    // Only attach model hooks when injection is enabled — avoids per-call
    // overhead on the hot path when no warnings can ever be queued.
    ...(shouldInject
      ? {
          wrapModelCall: async (
            _ctx: TurnContext,
            request: ModelRequest,
            next: (req: ModelRequest) => Promise<ModelResponse>,
          ): Promise<ModelResponse> => {
            return next(buildEnrichedRequest(request));
          },

          wrapModelStream: (
            _ctx: TurnContext,
            request: ModelRequest,
            next: (req: ModelRequest) => AsyncIterable<ModelChunk>,
          ): AsyncIterable<ModelChunk> => {
            return next(buildEnrichedRequest(request));
          },
        }
      : {}),

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
        if (detection.onWarning !== undefined) {
          detection.onWarning(info);
        }
        if (shouldInject) {
          pendingWarnings = [...pendingWarnings, info];
        }
      }

      // Check threshold
      if (newCount >= detection.threshold) {
        throw KoiEngineError.from(
          "TIMEOUT",
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
  validateWarningThreshold(
    "fanOutWarningAt",
    policy.fanOutWarningAt,
    "maxFanOut",
    policy.maxFanOut,
  );
  validateWarningThreshold(
    "totalProcessWarningAt",
    policy.totalProcessWarningAt,
    "maxTotalProcesses",
    policy.maxTotalProcesses,
  );

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
