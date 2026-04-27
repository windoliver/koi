/**
 * Forge demand detector middleware factory.
 *
 * Passive observer: monitors `wrapToolCall` and `wrapModelCall` to detect
 * capability gaps, repeated failures, latency degradation, and user
 * corrections. Mutates internal state only — never alters tool/model
 * results, never injects messages, never side-effects the agent loop.
 */

import type {
  CapabilityFragment,
  ForgeDemandSignal,
  ForgeTrigger,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { extractMessage, KoiRuntimeError } from "@koi/errors";
import type { DemandContext } from "./confidence.js";
import { computeDemandConfidence, DEFAULT_CONFIDENCE_WEIGHTS } from "./confidence.js";
import {
  DEFAULT_CAPABILITY_GAP_PATTERNS,
  DEFAULT_USER_CORRECTION_PATTERNS,
  detectLatencyDegradation,
  detectRepeatedFailure,
  detectUserCorrection,
} from "./heuristics.js";
import type { ForgeDemandConfig, ForgeDemandHandle, HeuristicThresholds } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PENDING_SIGNALS = 10;
const MAX_FAILED_CALL_MESSAGES = 10;
/** Chars from the match index used to scope per-gap counters. */
const GAP_CONTEXT_WINDOW = 120;
/** Max successful tool calls retained for user-correction attribution. */
const RECENT_TOOL_CALL_HISTORY = 16;

const DEFAULT_THRESHOLDS: HeuristicThresholds = {
  repeatedFailureCount: 3,
  capabilityGapOccurrences: 2,
  latencyDegradationAvgMs: 5_000,
  confidenceWeights: DEFAULT_CONFIDENCE_WEIGHTS,
} as const;

// ---------------------------------------------------------------------------
// Trigger key — dedup key for cooldowns
// ---------------------------------------------------------------------------

function triggerKey(trigger: ForgeTrigger): string {
  switch (trigger.kind) {
    case "repeated_failure":
      return `rf:${trigger.toolName}`;
    case "no_matching_tool":
      return `nmt:${trigger.query}`;
    case "capability_gap":
      return `cg:${trigger.requiredCapability}`;
    case "performance_degradation":
      return `pd:${trigger.toolName}`;
    case "user_correction":
      // Include the corrected tool so the same phrasing against different
      // tools does not collapse into a single cooldown bucket.
      return `uc:${trigger.correctedToolCall}|${trigger.correctionDescription.slice(0, 50)}`;
    default:
      return `other:${trigger.kind}`;
  }
}

function extractResponseText(response: ModelResponse): string {
  return typeof response.content === "string" ? response.content : "";
}

/**
 * Detect the `{ error: string; code: string }` in-band failure shape used by
 * many tools in this monorepo (read, write, edit, todo, etc.) instead of
 * throwing. Treating these as successes would silently hide real repeated
 * failures from the demand detector.
 */
function isInBandToolError(output: unknown): boolean {
  if (output === null || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  return typeof o.error === "string" && typeof o.code === "string";
}

/**
 * Invoke an observer callback without letting it alter control flow.
 *
 * The detector is documented as a passive observer — a throwing `onDemand`
 * or `onDismiss` must not turn a successful tool/model call into a failure
 * or mask the real error in the catch path.
 */
function safeInvoke<T>(cb: ((value: T) => void) | undefined, value: T): void {
  if (cb === undefined) return;
  try {
    cb(value);
  } catch (e: unknown) {
    // Last-resort isolation: callback errors are swallowed here so the
    // wrapped call is never altered. Surface via console.error so they
    // stay visible without affecting agent-loop semantics.
    console.error("[forge-demand] observer callback threw:", e);
  }
}

function mergeThresholds(overrides: Partial<HeuristicThresholds> | undefined): HeuristicThresholds {
  return {
    ...DEFAULT_THRESHOLDS,
    ...overrides,
    confidenceWeights: {
      ...DEFAULT_CONFIDENCE_WEIGHTS,
      ...overrides?.confidenceWeights,
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a forge demand detector middleware.
 *
 * Returns a `ForgeDemandHandle` bundling the middleware and the signal
 * query API. The middleware is passive — it never mutates requests or
 * responses; consumers query `getSignals()` and `dismiss()` externally.
 */
export function createForgeDemandDetector(config: ForgeDemandConfig): ForgeDemandHandle {
  const clock = config.clock ?? Date.now;
  const maxPending = config.maxPendingSignals ?? DEFAULT_MAX_PENDING_SIGNALS;
  const patterns = config.capabilityGapPatterns ?? DEFAULT_CAPABILITY_GAP_PATTERNS;
  const correctionPatterns = config.userCorrectionPatterns ?? DEFAULT_USER_CORRECTION_PATTERNS;
  const thresholds = mergeThresholds(config.heuristics);

  // Mutable state — encapsulated within the closure.
  const signals: ForgeDemandSignal[] = [];
  const cooldowns = new Map<string, number>();
  const consecutiveFailures = new Map<string, number>();
  const failedToolCalls = new Map<string, string[]>();
  const capabilityGapCounts = new Map<string, number>();
  const noMatchingToolCounts = new Map<string, number>();
  // Bounded log of recent successful tool calls. Used to attribute user
  // corrections to the tool the user is actually rejecting (the most recent
  // call before the user's message timestamp), not whichever tool happened
  // to run last in the session.
  const recentToolCalls: Array<{ readonly toolId: string; readonly at: number }> = [];
  // `let` justified: mutable counters scoped to this closure. Reset on session end.
  let signalCounter = 0;
  // Highest user-message timestamp already scanned for corrections.
  // Prevents replayed transcript history from re-firing on retry paths.
  let lastProcessedUserTimestamp = -1;
  // Forge-budget bookkeeping. Initialized lazily on first emission so the
  // session window starts when the detector actually sees traffic.
  let sessionStartedAt = -1;
  let sessionEmitCount = 0;

  function isOnCooldown(key: string): boolean {
    const lastEmitted = cooldowns.get(key);
    if (lastEmitted === undefined) return false;
    return clock() - lastEmitted < config.budget.cooldownMs;
  }

  function emitSignal(trigger: ForgeTrigger, context: DemandContext): void {
    const key = triggerKey(trigger);
    if (isOnCooldown(key)) return;

    // Forge-budget enforcement — both fields are checked here so the
    // detector's contract matches its declared `ForgeBudget`. Without this,
    // downstream consumers that trust the budget could keep receiving
    // signals after the session cap was exhausted.
    if (sessionStartedAt < 0) sessionStartedAt = clock();
    if (sessionEmitCount >= config.budget.maxForgesPerSession) return;
    if (clock() - sessionStartedAt >= config.budget.computeTimeBudgetMs) return;

    const confidence = computeDemandConfidence(trigger, thresholds.confidenceWeights, context);
    if (confidence < config.budget.demandThreshold) return;

    signalCounter += 1;
    const signal: ForgeDemandSignal = {
      id: `demand-${String(signalCounter)}`,
      kind: "forge_demand",
      trigger,
      confidence,
      // Slice keeps the demand pipeline simple — concrete brick-kind selection
      // is the responsibility of the consumer (auto-forge middleware).
      suggestedBrickKind: "tool",
      context: {
        failureCount: context.failureCount,
        failedToolCalls: failedToolCalls.get(key) ?? [],
      },
      emittedAt: clock(),
    };

    if (signals.length >= maxPending) {
      // Drop the oldest and clear its cooldown together — otherwise the
      // queue rolls over silently while still suppressing identical
      // detections for the remainder of the cooldown window.
      const evicted = signals.shift();
      if (evicted !== undefined) cooldowns.delete(triggerKey(evicted.trigger));
    }
    signals.push(signal);
    cooldowns.set(key, clock());
    sessionEmitCount += 1;
    safeInvoke(config.onDemand, signal);
  }

  function resetTriggerState(trigger: ForgeTrigger): void {
    // Clear the per-trigger counters so dismissal is a real acknowledgement.
    // Without this, the next matching event re-fires immediately because the
    // accumulator is still at or above threshold.
    switch (trigger.kind) {
      case "repeated_failure":
        consecutiveFailures.delete(trigger.toolName);
        failedToolCalls.delete(`rf:${trigger.toolName}`);
        return;
      case "no_matching_tool":
        noMatchingToolCounts.delete(trigger.query);
        return;
      case "capability_gap": {
        // requiredCapability carries the windowed bucket text; the bucket
        // key is `${pattern.source}|${requiredCapability}`. Clear every
        // pattern key matching this window text.
        const suffix = `|${trigger.requiredCapability}`;
        for (const k of capabilityGapCounts.keys()) {
          if (k.endsWith(suffix)) capabilityGapCounts.delete(k);
        }
        return;
      }
      default:
        return;
    }
  }

  function dismiss(signalId: string): void {
    const idx = signals.findIndex((s) => s.id === signalId);
    if (idx === -1) return;
    const signal = signals[idx];
    if (signal !== undefined) {
      cooldowns.delete(triggerKey(signal.trigger));
      resetTriggerState(signal.trigger);
    }
    signals.splice(idx, 1);
    safeInvoke(config.onDismiss, signalId);
  }

  function checkLatencyDegradation(toolId: string): void {
    if (config.healthTracker === undefined) return;
    const snapshot = config.healthTracker.getSnapshot(toolId);
    const trigger = detectLatencyDegradation(toolId, snapshot, thresholds.latencyDegradationAvgMs);
    if (trigger !== undefined) {
      emitSignal(trigger, {
        failureCount: snapshot?.metrics.avgLatencyMs ?? 0,
        threshold: thresholds.latencyDegradationAvgMs,
      });
    }
  }

  function checkCapabilityGaps(responseText: string): void {
    if (patterns.length === 0 || responseText.length === 0) return;
    for (const pattern of patterns) {
      // Defensive: reset stateful flags so a `g`/`y` regex cannot make
      // detection depend on prior calls (validator already rejects these,
      // but createForgeDemandDetector also accepts direct construction).
      pattern.lastIndex = 0;
      const match = pattern.exec(responseText);
      if (match === null) continue;
      // Bucket by the local context around the match (a normalized window
      // of the surrounding sentence) rather than just the regex pattern.
      // This stops unrelated capability gaps that share a phrasing template
      // ("I don't have a tool for X" / "...for Y") from accumulating into
      // a single forge signal while still letting genuine repeats add up.
      const matchStart = match.index;
      const windowText = responseText
        .slice(matchStart, matchStart + GAP_CONTEXT_WINDOW)
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
      const key = `${pattern.source}|${windowText}`;
      const count = (capabilityGapCounts.get(key) ?? 0) + 1;
      capabilityGapCounts.set(key, count);
      if (count < thresholds.capabilityGapOccurrences) continue;
      // Carry the windowed context as `requiredCapability` so the cooldown
      // key (built from `requiredCapability` in `triggerKey`) distinguishes
      // gaps that share a phrasing prefix. The bucket key and the cooldown
      // key are then aligned end-to-end.
      emitSignal(
        { kind: "capability_gap", requiredCapability: windowText },
        { failureCount: count, threshold: thresholds.capabilityGapOccurrences },
      );
    }
  }

  /**
   * Scan request.messages for user corrections WITHOUT emitting yet. Returns
   * the new high-water timestamp + the buffered triggers. The caller emits
   * and commits the watermark only after the wrapped model call succeeds
   * so a transient model failure + retry cannot:
   *   - drop the correction signal (watermark advanced before next), or
   *   - duplicate the correction signal (emit fired before next throws,
   *     then retry re-scans the same transcript and emits again).
   */
  function scanUserCorrections(request: ModelRequest): {
    readonly highWater: number;
    readonly triggers: readonly ForgeTrigger[];
  } {
    if (correctionPatterns.length === 0 || recentToolCalls.length === 0) {
      return { highWater: lastProcessedUserTimestamp, triggers: [] };
    }
    let highWater = lastProcessedUserTimestamp;
    const triggers: ForgeTrigger[] = [];
    for (const msg of request.messages) {
      if (msg.senderId !== "user") continue;
      if (msg.timestamp <= lastProcessedUserTimestamp) continue;
      if (msg.timestamp > highWater) highWater = msg.timestamp;
      // Attribute the correction to the most recent tool call that ran
      // BEFORE this user message — not the session-global last tool call.
      const correctedToolId = resolveCorrectedToolId(msg.timestamp);
      if (correctedToolId === "") continue;
      for (const block of msg.content) {
        if (block.kind !== "text") continue;
        const trigger = detectUserCorrection(block.text, correctionPatterns, correctedToolId);
        if (trigger !== undefined) triggers.push(trigger);
      }
    }
    return { highWater, triggers };
  }

  function resolveCorrectedToolId(userMessageTimestamp: number): string {
    // Walk back through recent calls; pick the latest with `at <= timestamp`,
    // falling back to the latest call if no timestamps line up (e.g. messages
    // carry timestamp 0 in tests).
    for (let i = recentToolCalls.length - 1; i >= 0; i -= 1) {
      const call = recentToolCalls[i];
      if (call !== undefined && call.at <= userMessageTimestamp) {
        return call.toolId;
      }
    }
    return recentToolCalls[recentToolCalls.length - 1]?.toolId ?? "";
  }

  function recordToolCall(toolId: string): void {
    recentToolCalls.push({ toolId, at: clock() });
    if (recentToolCalls.length > RECENT_TOOL_CALL_HISTORY) {
      recentToolCalls.splice(0, recentToolCalls.length - RECENT_TOOL_CALL_HISTORY);
    }
  }

  function recordFailure(toolId: string, e: unknown): number {
    const count = (consecutiveFailures.get(toolId) ?? 0) + 1;
    consecutiveFailures.set(toolId, count);
    const key = `rf:${toolId}`;
    const calls = failedToolCalls.get(key) ?? [];
    calls.push(extractMessage(e));
    if (calls.length > MAX_FAILED_CALL_MESSAGES) {
      calls.splice(0, calls.length - MAX_FAILED_CALL_MESSAGES);
    }
    failedToolCalls.set(key, calls);
    return count;
  }

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------

  const middleware: KoiMiddleware = {
    name: "forge-demand-detector",
    priority: 455,

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const { toolId } = request;
      try {
        const response = await next(request);
        // In-band errors must count as failures — many tools in this repo
        // return `{ error, code }` instead of throwing. Without this branch
        // repeated user-visible failures never reach `repeated_failure`.
        if (isInBandToolError(response.output)) {
          const inBand = new Error((response.output as { readonly error: string }).error);
          const count = recordFailure(toolId, inBand);
          const repeated = detectRepeatedFailure(toolId, count, thresholds.repeatedFailureCount);
          if (repeated !== undefined) {
            emitSignal(repeated, {
              failureCount: count,
              threshold: thresholds.repeatedFailureCount,
            });
          }
          checkLatencyDegradation(toolId);
          return response;
        }
        consecutiveFailures.set(toolId, 0);
        recordToolCall(toolId);
        checkLatencyDegradation(toolId);
        return response;
      } catch (e: unknown) {
        if (e instanceof KoiRuntimeError && e.code === "NOT_FOUND") {
          // Per-query attempt counter — confidence scales with severity so
          // repeated misses can clear the threshold even after a cooldown.
          // Threshold is 1 so a single miss can fire (the tool is known absent).
          const attempts = (noMatchingToolCounts.get(toolId) ?? 0) + 1;
          noMatchingToolCounts.set(toolId, attempts);
          emitSignal(
            { kind: "no_matching_tool", query: toolId, attempts },
            { failureCount: attempts, threshold: 1 },
          );
          checkLatencyDegradation(toolId);
          throw e;
        }

        const count = recordFailure(toolId, e);
        const repeated = detectRepeatedFailure(toolId, count, thresholds.repeatedFailureCount);
        if (repeated !== undefined) {
          emitSignal(repeated, { failureCount: count, threshold: thresholds.repeatedFailureCount });
        }
        checkLatencyDegradation(toolId);
        throw e;
      }
    },

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const { highWater, triggers } = scanUserCorrections(request);
      const response = await next(request);
      // Commit the watermark + emit corrections only after the model call
      // succeeds. This makes correction emission idempotent across retries
      // independently of cooldown configuration.
      lastProcessedUserTimestamp = highWater;
      for (const trigger of triggers) {
        emitSignal(trigger, { failureCount: 1, threshold: 1 });
      }
      checkCapabilityGaps(extractResponseText(response));
      return response;
    },

    async onSessionEnd(): Promise<void> {
      // Reset session-scoped state to avoid cross-session leakage.
      consecutiveFailures.clear();
      failedToolCalls.clear();
      capabilityGapCounts.clear();
      noMatchingToolCounts.clear();
      cooldowns.clear();
      signals.length = 0;
      signalCounter = 0;
      recentToolCalls.length = 0;
      lastProcessedUserTimestamp = -1;
      sessionStartedAt = -1;
      sessionEmitCount = 0;
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      if (signals.length === 0) return undefined;
      const plural = signals.length === 1 ? "" : "s";
      return {
        label: "forge-demand",
        description: `Forge demand: ${String(signals.length)} capability gap${plural} detected`,
      };
    },
  };

  return {
    middleware,
    getSignals: (): readonly ForgeDemandSignal[] => [...signals],
    dismiss,
    getActiveSignalCount: (): number => signals.length,
  };
}
