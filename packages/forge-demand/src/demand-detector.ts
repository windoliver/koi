/**
 * Forge demand detector middleware factory.
 *
 * Monitors tool calls and model responses for capability gaps,
 * repeated failures, and performance degradation. Emits ForgeDemandSignal
 * when patterns exceed configured thresholds.
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
import { extractMessage } from "@koi/errors";
import type { DemandContext } from "./confidence.js";
import { computeDemandConfidence, DEFAULT_CONFIDENCE_WEIGHTS } from "./confidence.js";
import {
  DEFAULT_CAPABILITY_GAP_PATTERNS,
  detectCapabilityGap,
  detectLatencyDegradation,
  detectRepeatedFailure,
} from "./heuristics.js";
import type { ForgeDemandConfig, ForgeDemandHandle, HeuristicThresholds } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_REPEATED_FAILURE_COUNT = 3;
const DEFAULT_CAPABILITY_GAP_OCCURRENCES = 2;
const DEFAULT_LATENCY_DEGRADATION_P95_MS = 5_000;
const DEFAULT_MAX_PENDING_SIGNALS = 10;

const DEFAULT_THRESHOLDS: HeuristicThresholds = {
  repeatedFailureCount: DEFAULT_REPEATED_FAILURE_COUNT,
  capabilityGapOccurrences: DEFAULT_CAPABILITY_GAP_OCCURRENCES,
  latencyDegradationP95Ms: DEFAULT_LATENCY_DEGRADATION_P95_MS,
  confidenceWeights: DEFAULT_CONFIDENCE_WEIGHTS,
} as const;

// ---------------------------------------------------------------------------
// Trigger key — deduplication key for cooldown tracking
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
  }
}

// ---------------------------------------------------------------------------
// Extract text from model response content blocks
// ---------------------------------------------------------------------------

function extractResponseText(response: ModelResponse): string {
  if (!Array.isArray(response.content)) return "";
  const parts: string[] = [];
  for (const block of response.content as readonly Record<string, unknown>[]) {
    if (typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a forge demand detector middleware.
 *
 * Returns a ForgeDemandHandle bundling the middleware + signal query API.
 */
export function createForgeDemandDetector(config: ForgeDemandConfig): ForgeDemandHandle {
  const clock = config.clock ?? Date.now;
  const maxPending = config.maxPendingSignals ?? DEFAULT_MAX_PENDING_SIGNALS;
  const patterns = config.capabilityGapPatterns ?? DEFAULT_CAPABILITY_GAP_PATTERNS;
  const thresholds: HeuristicThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...config.heuristics,
    confidenceWeights: {
      ...DEFAULT_CONFIDENCE_WEIGHTS,
      ...config.heuristics?.confidenceWeights,
    },
  };

  // Mutable state — encapsulated within closure
  // let: signal queue, cooldown map, failure counters, gap counts
  const signals: ForgeDemandSignal[] = [];
  const cooldowns = new Map<string, number>();
  const consecutiveFailures = new Map<string, number>();
  const failedToolCalls = new Map<string, string[]>();
  const capabilityGapCounts = new Map<string, number>();

  // let: monotonically increasing signal counter for unique IDs
  let signalCounter = 0;

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

    signalCounter++;
    const signal: ForgeDemandSignal = {
      id: `demand-${String(signalCounter)}`,
      kind: "forge_demand",
      trigger,
      confidence,
      suggestedBrickKind: "tool",
      context: {
        failureCount: context.failureCount,
        failedToolCalls: failedToolCalls.get(key) ?? [],
      },
      emittedAt: clock(),
    };

    // Bounded queue — evict oldest if full
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
      const key = triggerKey(signal.trigger);
      cooldowns.delete(key);
    }
    signals.splice(idx, 1);
    config.onDismiss?.(signalId);
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

      // let: response assigned inside try, used after
      let response: ToolResponse;
      try {
        response = await next(request);
      } catch (e: unknown) {
        // Record failure
        const count = (consecutiveFailures.get(toolId) ?? 0) + 1;
        consecutiveFailures.set(toolId, count);

        const calls = failedToolCalls.get(`rf:${toolId}`) ?? [];
        calls.push(extractMessage(e));
        failedToolCalls.set(`rf:${toolId}`, calls);

        // Check repeated failure heuristic
        const trigger = detectRepeatedFailure(toolId, count, thresholds.repeatedFailureCount);
        if (trigger !== undefined) {
          emitSignal(trigger, {
            failureCount: count,
            threshold: thresholds.repeatedFailureCount,
          });
        }

        // Check latency degradation via health tracker
        if (config.healthTracker !== undefined) {
          const snapshot = config.healthTracker.getHealthSnapshot(toolId);
          const latencyTrigger = detectLatencyDegradation(
            toolId,
            snapshot,
            thresholds.latencyDegradationP95Ms,
          );
          if (latencyTrigger !== undefined) {
            emitSignal(latencyTrigger, {
              failureCount: snapshot?.metrics.usageCount ?? 0,
              threshold: thresholds.latencyDegradationP95Ms,
            });
          }
        }

        throw e;
      }

      // Success — reset consecutive failure counter
      consecutiveFailures.set(toolId, 0);

      // Check latency degradation on success too
      if (config.healthTracker !== undefined) {
        const snapshot = config.healthTracker.getHealthSnapshot(toolId);
        const latencyTrigger = detectLatencyDegradation(
          toolId,
          snapshot,
          thresholds.latencyDegradationP95Ms,
        );
        if (latencyTrigger !== undefined) {
          emitSignal(latencyTrigger, {
            failureCount: snapshot?.metrics.usageCount ?? 0,
            threshold: thresholds.latencyDegradationP95Ms,
          });
        }
      }

      return response;
    },

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const response = await next(request);

      // Fast path: no patterns configured
      if (patterns.length === 0) return response;

      const responseText = extractResponseText(response);
      if (responseText.length === 0) return response;

      // Check capability gap patterns
      const trigger = detectCapabilityGap(
        responseText,
        patterns,
        capabilityGapCounts,
        thresholds.capabilityGapOccurrences,
      );

      if (trigger !== undefined) {
        // Update gap counts (mutation justified: encapsulated in closure)
        for (const pattern of patterns) {
          const match = pattern.exec(responseText);
          if (match !== null) {
            const capability = match[0];
            capabilityGapCounts.set(capability, (capabilityGapCounts.get(capability) ?? 0) + 1);
          }
        }

        const gapKey = trigger.kind === "capability_gap" ? trigger.requiredCapability : "";
        emitSignal(trigger, {
          failureCount: capabilityGapCounts.get(gapKey) ?? 1,
          threshold: thresholds.capabilityGapOccurrences,
        });
      } else {
        // Still track gap counts even when below threshold
        for (const pattern of patterns) {
          const match = pattern.exec(responseText);
          if (match !== null) {
            const capability = match[0];
            capabilityGapCounts.set(capability, (capabilityGapCounts.get(capability) ?? 0) + 1);
          }
        }
      }

      return response;
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      if (signals.length === 0) return undefined;
      return {
        label: "forge-demand",
        description: `Forge demand: ${String(signals.length)} capability gap${signals.length === 1 ? "" : "s"} detected — consider forging new tools`,
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
