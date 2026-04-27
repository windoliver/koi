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

const DEFAULT_THRESHOLDS: HeuristicThresholds = {
  repeatedFailureCount: 3,
  capabilityGapOccurrences: 2,
  latencyDegradationP95Ms: 5_000,
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
      return `uc:${trigger.correctionDescription.slice(0, 50)}`;
    default:
      return `other:${trigger.kind}`;
  }
}

function extractResponseText(response: ModelResponse): string {
  return typeof response.content === "string" ? response.content : "";
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
  // `let` justified: mutable counters scoped to this closure. Reset on session end.
  let signalCounter = 0;
  let lastToolCallId = "";
  // Highest user-message timestamp already scanned for corrections.
  // Prevents replayed transcript history from re-firing on retry paths.
  let lastProcessedUserTimestamp = -1;

  function isOnCooldown(key: string): boolean {
    const lastEmitted = cooldowns.get(key);
    if (lastEmitted === undefined) return false;
    return clock() - lastEmitted < config.budget.cooldownMs;
  }

  function emitSignal(trigger: ForgeTrigger, context: DemandContext): void {
    const key = triggerKey(trigger);
    if (isOnCooldown(key)) return;

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
      signals.shift();
    }
    signals.push(signal);
    cooldowns.set(key, clock());
    safeInvoke(config.onDemand, signal);
  }

  function dismiss(signalId: string): void {
    const idx = signals.findIndex((s) => s.id === signalId);
    if (idx === -1) return;
    const signal = signals[idx];
    if (signal !== undefined) {
      cooldowns.delete(triggerKey(signal.trigger));
    }
    signals.splice(idx, 1);
    safeInvoke(config.onDismiss, signalId);
  }

  function checkLatencyDegradation(toolId: string): void {
    if (config.healthTracker === undefined) return;
    const snapshot = config.healthTracker.getSnapshot(toolId);
    const trigger = detectLatencyDegradation(toolId, snapshot, thresholds.latencyDegradationP95Ms);
    if (trigger !== undefined) {
      emitSignal(trigger, {
        failureCount: snapshot?.metrics.avgLatencyMs ?? 0,
        threshold: thresholds.latencyDegradationP95Ms,
      });
    }
  }

  function checkCapabilityGaps(responseText: string): void {
    if (patterns.length === 0 || responseText.length === 0) return;
    for (const pattern of patterns) {
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
      emitSignal(
        { kind: "capability_gap", requiredCapability: match[0] },
        { failureCount: count, threshold: thresholds.capabilityGapOccurrences },
      );
    }
  }

  function checkUserCorrections(request: ModelRequest): void {
    if (correctionPatterns.length === 0 || lastToolCallId === "") return;
    // Only inspect user-authored messages newer than the last one we've
    // already scanned. This prevents replayed transcript history (e.g. on
    // retry paths) from re-firing the same correction repeatedly, and
    // avoids treating assistant text as a user correction.
    let highWater = lastProcessedUserTimestamp;
    for (const msg of request.messages) {
      if (msg.senderId !== "user") continue;
      if (msg.timestamp <= lastProcessedUserTimestamp) continue;
      if (msg.timestamp > highWater) highWater = msg.timestamp;
      for (const block of msg.content) {
        if (block.kind !== "text") continue;
        const trigger = detectUserCorrection(block.text, correctionPatterns, lastToolCallId);
        if (trigger !== undefined) {
          emitSignal(trigger, { failureCount: 1, threshold: 1 });
        }
      }
    }
    lastProcessedUserTimestamp = highWater;
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
        consecutiveFailures.set(toolId, 0);
        lastToolCallId = toolId;
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
      checkUserCorrections(request);
      const response = await next(request);
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
      lastToolCallId = "";
      lastProcessedUserTimestamp = -1;
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
