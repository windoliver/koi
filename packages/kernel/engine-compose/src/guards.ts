/**
 * Engine guards — KoiMiddleware implementations for iteration limits,
 * loop detection, and spawn governance.
 *
 * Each guard is created by a factory function that closes over mutable state.
 * State is reset per session via onSessionStart hooks, so guards are safe
 * to reuse across multiple run() calls on the same KoiRuntime.
 */

import type {
  Agent,
  GovernanceController,
  InboundMessage,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  TurnContext,
  TurnId,
} from "@koi/core";
import { GOVERNANCE } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { fnv1a } from "@koi/hash";
import type {
  DepthToolRule,
  IterationLimits,
  LoopDetectionConfig,
  LoopWarningInfo,
  SpawnPolicy,
} from "./guard-types.js";
import {
  DEFAULT_ITERATION_LIMITS,
  DEFAULT_LOOP_DETECTION,
  DEFAULT_SPAWN_POLICY,
  DEFAULT_SPAWN_TOOL_IDS,
} from "./guard-types.js";

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
    throw KoiRuntimeError.from(
      "VALIDATION",
      `${warningName} (${warningValue}) must be less than ${limitName} (${limitValue})`,
      { context: { [warningName]: warningValue, [limitName]: limitValue } },
    );
  }
}

// ---------------------------------------------------------------------------
// Iteration Guard — stream timeout helpers
// ---------------------------------------------------------------------------

interface EffectiveTimeout {
  readonly ms: number;
  readonly source: "wall_clock" | "inactivity";
}

/**
 * Compute the effective timeout for the next awaited operation based on both
 * wall-clock and inactivity limits. Returns the tighter of the two with its
 * source, or undefined if no timeout enforcement is active.
 */
function computeEffectiveTimeout(
  limits: IterationLimits,
  startedAt: number,
  lastActivityMs: number,
): EffectiveTimeout | undefined {
  const now = Date.now();
  // let justified: mutable tracking of best (smallest) timeout candidate
  let bestMs: number | undefined;
  let bestSource: "wall_clock" | "inactivity" = "wall_clock";

  // Wall-clock remaining
  const wallRemaining = limits.maxDurationMs - (now - startedAt);
  if (wallRemaining <= 0) {
    return { ms: 0, source: "wall_clock" };
  }
  bestMs = wallRemaining;
  bestSource = "wall_clock";

  // Inactivity remaining
  if (limits.maxInactivityMs !== undefined) {
    const inactivityRemaining = limits.maxInactivityMs - (now - lastActivityMs);
    if (inactivityRemaining <= 0) {
      return { ms: 0, source: "inactivity" };
    }
    if (inactivityRemaining < bestMs) {
      bestMs = inactivityRemaining;
      bestSource = "inactivity";
    }
  }

  return bestMs !== undefined ? { ms: bestMs, source: bestSource } : undefined;
}

/**
 * Create a promise that rejects after `ms` milliseconds with a TIMEOUT error.
 * The timer is unref'd so it doesn't keep the process alive.
 */
function createTimeoutRejection(
  timeout: EffectiveTimeout,
  limits: IterationLimits,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      const message =
        timeout.source === "inactivity"
          ? `Inactivity timeout: no activity for ${limits.maxInactivityMs}ms (limit: ${limits.maxInactivityMs}ms)`
          : `Duration limit exceeded: ${limits.maxDurationMs}ms wall-clock limit reached`;
      reject(
        KoiRuntimeError.from("TIMEOUT", message, {
          retryable: false,
          context:
            timeout.source === "inactivity"
              ? { maxInactivityMs: limits.maxInactivityMs }
              : { maxDurationMs: limits.maxDurationMs },
        }),
      );
    }, timeout.ms);
    // Unref so the timer doesn't prevent process exit
    if (typeof timer === "object" && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  });
}

// ---------------------------------------------------------------------------
// Iteration Guard
// ---------------------------------------------------------------------------

export function createIterationGuard(config?: Partial<IterationLimits>): KoiMiddleware {
  const limits: IterationLimits = {
    ...DEFAULT_ITERATION_LIMITS,
    ...config,
  };

  // let justified: mutable counters reset per session via onSessionStart
  let turns = 0;
  let totalTokens = 0;
  // let justified: mutable timestamps reset per session via onSessionStart
  let startedAt = Date.now();
  // let justified: mutable inactivity tracker — reset on every model chunk and tool call
  let lastActivityMs = Date.now();

  /** Reset the inactivity timer. Called on model stream chunks and tool call boundaries. */
  function touchActivity(): void {
    lastActivityMs = Date.now();
  }

  function checkLimits(): void {
    if (turns >= limits.maxTurns) {
      throw KoiRuntimeError.from("TIMEOUT", `Max turns exceeded: ${turns}/${limits.maxTurns}`, {
        retryable: false,
        context: { turns, maxTurns: limits.maxTurns },
      });
    }

    // Hard wall-clock safety cap — always enforced
    const elapsed = Date.now() - startedAt;
    if (elapsed >= limits.maxDurationMs) {
      throw KoiRuntimeError.from(
        "TIMEOUT",
        `Duration limit exceeded: ${elapsed}ms/${limits.maxDurationMs}ms`,
        {
          retryable: false,
          context: { elapsedMs: elapsed, maxDurationMs: limits.maxDurationMs },
        },
      );
    }

    // Inactivity check — fires when no events emitted for maxInactivityMs
    if (limits.maxInactivityMs !== undefined) {
      const idle = Date.now() - lastActivityMs;
      if (idle >= limits.maxInactivityMs) {
        throw KoiRuntimeError.from(
          "TIMEOUT",
          `Inactivity timeout: no activity for ${idle}ms (limit: ${limits.maxInactivityMs}ms)`,
          {
            retryable: false,
            context: { idleMs: idle, maxInactivityMs: limits.maxInactivityMs },
          },
        );
      }
    }

    if (totalTokens >= limits.maxTokens) {
      throw KoiRuntimeError.from(
        "TIMEOUT",
        `Token budget exhausted: ${totalTokens}/${limits.maxTokens}`,
        {
          retryable: false,
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
    describeCapabilities: () => undefined,
    priority: 0,

    onSessionStart: async () => {
      turns = 0;
      totalTokens = 0;
      startedAt = Date.now();
      lastActivityMs = Date.now();
    },

    wrapModelCall: async (_ctx, request, next) => {
      checkLimits();
      touchActivity();

      // Race the model call against inactivity + wall-clock timeouts.
      // Without this, a non-streaming provider that stops responding would
      // hang the session indefinitely (same risk as stalled streams).
      const timeout = computeEffectiveTimeout(limits, startedAt, lastActivityMs);
      const response =
        timeout === undefined
          ? await next(request)
          : await Promise.race([next(request), createTimeoutRejection(timeout, limits)]);
      touchActivity();

      trackUsage(response.usage?.inputTokens ?? 0, response.usage?.outputTokens ?? 0);

      return response;
    },

    wrapModelStream: (_ctx, request, next) => {
      checkLimits();
      touchActivity();

      return {
        async *[Symbol.asyncIterator]() {
          const iter = next(request)[Symbol.asyncIterator]();
          try {
            for (;;) {
              // Race the next chunk against inactivity + wall-clock timeouts.
              // Without this, a stalled provider stream would hang indefinitely.
              const chunkTimeout = computeEffectiveTimeout(limits, startedAt, lastActivityMs);
              const result =
                chunkTimeout === undefined
                  ? await iter.next()
                  : await Promise.race([iter.next(), createTimeoutRejection(chunkTimeout, limits)]);
              if (result.done) break;
              const chunk = result.value;
              touchActivity();
              yield chunk;
              if (chunk.kind === "done") {
                trackUsage(
                  chunk.response.usage?.inputTokens ?? 0,
                  chunk.response.usage?.outputTokens ?? 0,
                );
              }
            }
          } finally {
            // Cancel the underlying provider stream on timeout or early exit
            // to prevent leaked connections and background token consumption.
            await iter.return?.();
          }
        },
      };
    },

    wrapToolCall: async (_ctx, request, next) => {
      checkLimits();
      touchActivity();
      const response = await next(request);
      // Reset activity after successful completion — the tool executed and
      // committed side effects. Throwing here would discard a valid result.
      // Limits are re-checked at the next model/tool boundary.
      touchActivity();
      return response;
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
    throw KoiRuntimeError.from(
      "TIMEOUT",
      `Loop detected: tool "${toolId}" called with identical arguments ${newCount} times in last ${windowSize} calls`,
      {
        retryable: false,
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
    throw KoiRuntimeError.from(
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
      throw KoiRuntimeError.from(
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

  validateWarningThreshold(
    "warningThreshold",
    detection.warningThreshold,
    "threshold",
    detection.threshold,
  );

  // Circular buffer for O(1) insert + evict
  const ringBuffer = new Array<number>(detection.windowSize).fill(0);
  // let justified: mutable write cursor and fill count for circular buffer, reset per session
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

  /** Queued warnings to inject into the next model call. */
  // let justified: mutable binding swapped on each injection cycle
  let pendingWarnings: readonly LoopWarningInfo[] = [];

  /** Reset all mutable state for a new session. */
  function resetState(): void {
    ringBuffer.fill(0);
    cursor = 0;
    filled = 0;
    hashCounts.clear();
    firedWarnings.clear();
    noProgressState.clear();
    pendingWarnings = [];
  }

  // Both conditions required: injectWarning must not be explicitly disabled,
  // AND warningThreshold must be set (otherwise no warnings are ever generated).
  const shouldInject =
    detection.injectWarning !== false && detection.warningThreshold !== undefined;

  /**
   * Build an InboundMessage from queued warnings and prepend to request.messages.
   * Uses senderId: "system:loop-detector" for system-injected messages.
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
    describeCapabilities: () => undefined,
    priority: 1,

    onSessionStart: async () => {
      resetState();
    },

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
// Depth-based tool restriction helper
// ---------------------------------------------------------------------------

/**
 * Build a Set of denied tool IDs for the given agent depth.
 * Returns undefined if no rules match (avoids allocating an empty Set).
 */
function computeDeniedTools(
  rules: readonly DepthToolRule[],
  agentDepth: number,
): ReadonlySet<string> | undefined {
  const denied = rules.filter((rule) => agentDepth >= rule.minDepth).map((rule) => rule.toolId);
  return denied.length > 0 ? new Set(denied) : undefined;
}

// ---------------------------------------------------------------------------
// Spawn Guard
// ---------------------------------------------------------------------------

/**
 * Options for creating a spawn guard middleware.
 *
 * The spawn guard enforces:
 * - Depth limits (structural, PERMISSION error)
 * - GovernanceController checks (PERMISSION error)
 * - Fan-out limits (transient, RATE_LIMIT error)
 *
 * Ledger management (tree-wide process slots) is handled by `spawnChildAgent()`,
 * which ties slot lifetime to child termination rather than tool call duration.
 */
export interface CreateSpawnGuardOptions {
  /** Spawn governance policy. Merged with DEFAULT_SPAWN_POLICY. */
  readonly policy?: Partial<SpawnPolicy>;
  /** Depth of the current agent in the process tree (0 = root). */
  readonly agentDepth?: number;
  /** Agent entity — if present, GovernanceController will be consulted. */
  readonly agent?: Agent;
}

export function createSpawnGuard(options?: CreateSpawnGuardOptions): KoiMiddleware {
  const { policy: configOverrides, agentDepth = 0, agent } = options ?? {};

  const policy: SpawnPolicy = {
    ...DEFAULT_SPAWN_POLICY,
    ...configOverrides,
  };

  // Validate warning threshold at construction time
  validateWarningThreshold(
    "fanOutWarningAt",
    policy.fanOutWarningAt,
    "maxFanOut",
    policy.maxFanOut,
  );

  // Build spawn tool ID set for O(1) lookup
  const spawnToolIds = new Set<string>(policy.spawnToolIds ?? DEFAULT_SPAWN_TOOL_IDS);

  // Build denied tool set for this agent's depth (computed once at construction)
  const deniedTools =
    policy.toolRestrictions !== undefined
      ? computeDeniedTools(policy.toolRestrictions, agentDepth)
      : undefined;

  // Cache GovernanceController lookup — fixed after assembly, no need to look up per-call
  const governance = agent?.component<GovernanceController>(GOVERNANCE);

  // let justified: mutable concurrent in-flight child counter. Matters if
  // a future engine parallelises tool dispatch — protects against literal
  // simultaneous runaway children.
  let directChildren = 0;
  // let justified: mutable per-turn spawn counter. Required because today's
  // engines (see @koi/query-engine turn-runner) execute batched tool calls
  // sequentially via `for … await`, so the in-flight counter never exceeds
  // 1 and burst fan-out within one tool_use batch was silently bypassed
  // (#1793). Keyed off `TurnContext.turnId` so cooperating adapters that
  // call the model multiple times per turn (stop-gate retries, planner→
  // executor loops) share a single per-turn budget.
  let spawnsThisTurn = 0;
  // let justified: mutable last-seen turn id — the true turn-boundary
  // signal. Model-call hooks alone are not, because adapters may call the
  // model many times per turn.
  let lastTurnId: TurnId | undefined;

  // let justified: mutable flag to fire fan-out warning at most once per session
  let firedFanOutWarning = false;

  /** Reset the per-turn counter iff we've crossed into a new turn. */
  function syncTurnBoundary(ctx: TurnContext): void {
    if (ctx.turnId !== lastTurnId) {
      lastTurnId = ctx.turnId;
      spawnsThisTurn = 0;
    }
  }

  return {
    name: "koi:spawn-guard",
    describeCapabilities: () => undefined,
    priority: 2,

    onSessionStart: async () => {
      directChildren = 0;
      spawnsThisTurn = 0;
      lastTurnId = undefined;
      firedFanOutWarning = false;
    },

    wrapToolCall: async (ctx, request, next) => {
      // Reset the per-turn burst counter at the true turn boundary — a
      // change in TurnContext.turnId. This is the #1793 enforcement point
      // for sequential tool-batch execution.
      syncTurnBoundary(ctx);

      // 0. Check depth-based tool restrictions (applies to ALL tools)
      if (deniedTools?.has(request.toolId)) {
        throw KoiRuntimeError.from(
          "PERMISSION",
          `Tool "${request.toolId}" is not allowed at depth ${agentDepth}`,
          {
            context: { toolId: request.toolId, agentDepth },
          },
        );
      }

      // Early return for non-spawn tools (hot path — O(1) set lookup)
      if (!spawnToolIds.has(request.toolId)) {
        return next(request);
      }

      // 1. Check depth (structural, PERMISSION — not retryable)
      const childDepth = agentDepth + 1;
      if (childDepth > policy.maxDepth) {
        throw KoiRuntimeError.from(
          "PERMISSION",
          `Max spawn depth exceeded: child would be at depth ${childDepth}, limit is ${policy.maxDepth}`,
          {
            context: { agentDepth, childDepth, maxDepth: policy.maxDepth },
          },
        );
      }

      // 2. Consult GovernanceController (cached at construction)
      if (governance !== undefined) {
        const check = await governance.check("spawn_depth");
        if (!check.ok) {
          throw KoiRuntimeError.from("PERMISSION", check.reason, {
            context: { childDepth, source: "GovernanceController", variable: check.variable },
          });
        }
      }

      // 3. Check fan-out — dual enforcement:
      //    a) `directChildren` — live child lifetime (matters if tools run
      //       in parallel; released when the child terminates).
      //    b) `spawnsThisTurn` — per-turn batch cumulative (catches sequential
      //       fan-out bursts that today's serialised tool runner couldn't
      //       detect via the in-flight counter, #1793).
      //    Both check against the same maxFanOut — whichever hits first
      //    throws RATE_LIMIT (retryable: a follow-up turn resets the burst
      //    counter and freed child slots replenish the in-flight counter).
      if (directChildren >= policy.maxFanOut) {
        throw KoiRuntimeError.from(
          "RATE_LIMIT",
          `Max fan-out exceeded: ${directChildren}/${policy.maxFanOut} concurrent children`,
          {
            retryable: true,
            context: { directChildren, maxFanOut: policy.maxFanOut, reason: "concurrent" },
          },
        );
      }
      if (spawnsThisTurn >= policy.maxFanOut) {
        throw KoiRuntimeError.from(
          "RATE_LIMIT",
          `Max fan-out exceeded: ${spawnsThisTurn}/${policy.maxFanOut} children in this turn`,
          {
            retryable: true,
            context: { spawnsThisTurn, maxFanOut: policy.maxFanOut, reason: "per_turn_burst" },
          },
        );
      }

      // 4. Optimistic: increment both counters before next()
      directChildren++;
      spawnsThisTurn++;

      // 5. Fire fan-out warning — at most once per session, and cover
      //    BOTH enforcement paths. In the sequential turn-runner path
      //    directChildren dips back to 0 between awaited spawns, so the
      //    warning would never fire for same-turn bursts if it were
      //    keyed only off directChildren (#1793).
      if (
        !firedFanOutWarning &&
        policy.fanOutWarningAt !== undefined &&
        policy.onWarning !== undefined
      ) {
        const concurrentTriggered = directChildren >= policy.fanOutWarningAt;
        const burstTriggered = spawnsThisTurn >= policy.fanOutWarningAt;
        if (concurrentTriggered || burstTriggered) {
          firedFanOutWarning = true;
          // Prefer whichever counter is higher so operators see the most
          // pressing pressure first. On ties, prefer "concurrent" because
          // in-flight children are the more immediate resource pressure.
          const useBurst =
            burstTriggered && (!concurrentTriggered || spawnsThisTurn > directChildren);
          policy.onWarning({
            kind: "fan_out",
            reason: useBurst ? "per_turn_burst" : "concurrent",
            current: useBurst ? spawnsThisTurn : directChildren,
            limit: policy.maxFanOut,
            warningAt: policy.fanOutWarningAt,
          });
        }
      }

      // 6. Execute spawn:
      //    - directChildren always decrements (the in-flight slot is
      //      freed when this tool call unwinds, success or failure).
      //    - spawnsThisTurn is NOT refunded on throw. Rationale: by the
      //      time we reach this try block, all guard pre-flight checks
      //      (depth, fan-out, governance) have already passed, meaning
      //      the request cleared our admission gate and the downstream
      //      spawn executor (which may launch the child before later
      //      reporting failure) has taken over. A thrown error no longer
      //      means "nothing launched" — e.g. a child that starts and
      //      then fails during its own run still counts against the
      //      per-turn burst budget. Refunding would let a parent spam
      //      failing spawns past the cap.
      try {
        return await next(request);
      } finally {
        directChildren--;
      }
    },
  };
}
