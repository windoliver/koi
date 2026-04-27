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
  detectCapabilityGap,
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
  // `let` justified: mutable counters scoped to this closure. Reset on session end.
  let signalCounter = 0;
  let lastToolCallId = "";

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
    config.onDemand?.(signal);
  }

  function dismiss(signalId: string): void {
    const idx = signals.findIndex((s) => s.id === signalId);
    if (idx === -1) return;
    const signal = signals[idx];
    if (signal !== undefined) {
      cooldowns.delete(triggerKey(signal.trigger));
    }
    signals.splice(idx, 1);
    config.onDismiss?.(signalId);
  }

  function checkLatencyDegradation(toolId: string): void {
    if (config.healthTracker === undefined) return;
    const snapshot = config.healthTracker.getHealthSnapshot(toolId);
    const trigger = detectLatencyDegradation(toolId, snapshot, thresholds.latencyDegradationP95Ms);
    if (trigger !== undefined) {
      emitSignal(trigger, {
        failureCount: snapshot?.metrics.avgLatencyMs ?? 0,
        threshold: thresholds.latencyDegradationP95Ms,
      });
    }
  }

  function updateGapCounts(responseText: string): void {
    for (const pattern of patterns) {
      if (pattern.test(responseText)) {
        const key = pattern.source;
        capabilityGapCounts.set(key, (capabilityGapCounts.get(key) ?? 0) + 1);
      }
    }
  }

  function checkCapabilityGaps(responseText: string): void {
    if (patterns.length === 0 || responseText.length === 0) return;
    updateGapCounts(responseText);
    const trigger = detectCapabilityGap(
      responseText,
      patterns,
      capabilityGapCounts,
      thresholds.capabilityGapOccurrences,
    );
    if (trigger === undefined) return;
    const gapKey = trigger.kind === "capability_gap" ? trigger.requiredCapability : "";
    emitSignal(trigger, {
      failureCount: capabilityGapCounts.get(gapKey) ?? 1,
      threshold: thresholds.capabilityGapOccurrences,
    });
  }

  function checkUserCorrections(request: ModelRequest): void {
    if (correctionPatterns.length === 0 || lastToolCallId === "") return;
    for (const msg of request.messages) {
      if (msg.senderId === "system" || msg.senderId === "system:ace") continue;
      for (const block of msg.content) {
        if (block.kind !== "text") continue;
        const trigger = detectUserCorrection(block.text, correctionPatterns, lastToolCallId);
        if (trigger !== undefined) {
          emitSignal(trigger, { failureCount: 1, threshold: 1 });
        }
      }
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
        consecutiveFailures.set(toolId, 0);
        lastToolCallId = toolId;
        checkLatencyDegradation(toolId);
        return response;
      } catch (e: unknown) {
        if (e instanceof KoiRuntimeError && e.code === "NOT_FOUND") {
          emitSignal(
            { kind: "no_matching_tool", query: toolId, attempts: 1 },
            { failureCount: 1, threshold: thresholds.repeatedFailureCount },
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
      cooldowns.clear();
      signals.length = 0;
      signalCounter = 0;
      lastToolCallId = "";
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
