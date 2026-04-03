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
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { extractMessage, KoiRuntimeError } from "@koi/errors";
import { selectBrickKind } from "./brick-kind-selector.js";
import type { DemandContext } from "./confidence.js";
import { computeDemandConfidence, DEFAULT_CONFIDENCE_WEIGHTS } from "./confidence.js";
import {
  DEFAULT_CAPABILITY_GAP_PATTERNS,
  DEFAULT_USER_CORRECTION_PATTERNS,
  detectCapabilityGap,
  detectComplexTaskCompletion,
  detectLatencyDegradation,
  detectNovelWorkflow,
  detectRepeatedFailure,
  detectUserCorrection,
} from "./heuristics.js";
import type { ForgeDemandConfig, ForgeDemandHandle, HeuristicThresholds } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_REPEATED_FAILURE_COUNT = 3;
const DEFAULT_CAPABILITY_GAP_OCCURRENCES = 2;
const DEFAULT_LATENCY_DEGRADATION_P95_MS = 5_000;
const DEFAULT_MAX_PENDING_SIGNALS = 10;
const DEFAULT_COMPLEX_TASK_TOOL_CALL_THRESHOLD = 5;
const DEFAULT_NOVEL_WORKFLOW_MIN_LENGTH = 3;
/** Maximum error messages kept per tool in failedToolCalls (memory cap). */
const MAX_FAILED_CALL_MESSAGES = 10;

const DEFAULT_THRESHOLDS: HeuristicThresholds = {
  repeatedFailureCount: DEFAULT_REPEATED_FAILURE_COUNT,
  capabilityGapOccurrences: DEFAULT_CAPABILITY_GAP_OCCURRENCES,
  latencyDegradationP95Ms: DEFAULT_LATENCY_DEGRADATION_P95_MS,
  complexTaskToolCallThreshold: DEFAULT_COMPLEX_TASK_TOOL_CALL_THRESHOLD,
  novelWorkflowMinLength: DEFAULT_NOVEL_WORKFLOW_MIN_LENGTH,
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
    case "agent_capability_gap":
      return `acg:${trigger.agentType}`;
    case "agent_repeated_failure":
      return `arf:${trigger.agentType}:${trigger.brickId}`;
    case "agent_latency_degradation":
      return `ald:${trigger.agentType}:${trigger.brickId}`;
    // Success-side triggers
    case "complex_task_completed":
      return `ctc:${trigger.taskDescription.slice(0, 50)}`;
    case "user_correction":
      return `uc:${trigger.correctionDescription.slice(0, 50)}`;
    case "novel_workflow":
      return `nw:${trigger.workflowDescription.slice(0, 50)}`;
    // Data source triggers
    case "data_source_detected":
      return `dsd:${trigger.sourceName}`;
    case "data_source_gap":
      return `dsg:${trigger.sourceName}:${trigger.missingCapability}`;
  }
  // Exhaustiveness guard — compiler errors if a trigger kind is missing above
  const _exhaustive: never = trigger;
  return `unknown:${String((_exhaustive as ForgeTrigger).kind)}`;
}

// ---------------------------------------------------------------------------
// Extract text from model response content blocks
// ---------------------------------------------------------------------------

function extractResponseText(response: ModelResponse): string {
  return typeof response.content === "string" ? response.content : "";
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
  const correctionPatterns = config.userCorrectionPatterns ?? DEFAULT_USER_CORRECTION_PATTERNS;
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

  // let: session-scoped tool call tracking for success-side triggers
  let sessionToolCallCount = 0;
  let sessionTurnCount = 0;
  const sessionToolSequence: string[] = [];
  // let: tracks the most recent tool call for user correction attribution
  let lastToolCallId = "";

  // let: monotonically increasing signal counter for unique IDs
  let signalCounter = 0;

  function isOnCooldown(key: string): boolean {
    const lastEmitted = cooldowns.get(key);
    if (lastEmitted === undefined) return false;
    return clock() - lastEmitted < config.budget.cooldownMs;
  }

  /** Evict expired cooldown entries and stale tracking maps to prevent unbounded memory growth. */
  function evictExpiredCooldowns(): void {
    const now = clock();
    for (const [key, lastEmitted] of cooldowns) {
      if (now - lastEmitted >= config.budget.cooldownMs) {
        cooldowns.delete(key);
      }
    }
    // Evict tracking maps for tools with zero consecutive failures (resolved)
    for (const [toolId, count] of consecutiveFailures) {
      if (count === 0) {
        consecutiveFailures.delete(toolId);
        failedToolCalls.delete(`rf:${toolId}`);
      }
    }
    // Evict capability gap counts for expired cooldowns (no longer active)
    for (const capability of capabilityGapCounts.keys()) {
      if (!cooldowns.has(`cg:${capability}`)) {
        capabilityGapCounts.delete(capability);
      }
    }
  }

  function emitSignal(trigger: ForgeTrigger, context: DemandContext): void {
    const key = triggerKey(trigger);
    if (isOnCooldown(key)) return;

    // Use real brick-kind selector instead of hardcoded "tool"
    const selection = selectBrickKind(trigger);
    if (selection.suppressed) return;

    const confidence = computeDemandConfidence(trigger, thresholds.confidenceWeights, context);

    if (confidence < config.budget.demandThreshold) return;

    signalCounter++;
    const signal: ForgeDemandSignal = {
      id: `demand-${String(signalCounter)}`,
      kind: "forge_demand",
      trigger,
      confidence,
      suggestedBrickKind: selection.kind,
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

    // Periodic eviction of expired cooldowns to prevent unbounded growth
    evictExpiredCooldowns();
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
  // Helpers
  // ---------------------------------------------------------------------------

  /** Check latency degradation via health tracker and emit signal if threshold exceeded. */
  function checkLatencyDegradation(toolId: string): void {
    if (config.healthTracker === undefined) return;
    const snapshot = config.healthTracker.getHealthSnapshot(toolId);
    const latencyTrigger = detectLatencyDegradation(
      toolId,
      snapshot,
      thresholds.latencyDegradationP95Ms,
    );
    if (latencyTrigger !== undefined) {
      emitSignal(latencyTrigger, {
        failureCount: snapshot?.metrics.avgLatencyMs ?? 0,
        threshold: thresholds.latencyDegradationP95Ms,
      });
    }
  }

  /** Update capability gap counts for all matching patterns in the response text. */
  function updateGapCounts(responseText: string): void {
    for (const pattern of patterns) {
      const match = pattern.exec(responseText);
      if (match !== null) {
        // Normalize key by pattern source — different phrasings of the same gap
        // (e.g., "I don't have a PDF tool" vs "I don't have a chart tool") should
        // count together since they match the same pattern.
        const key = pattern.source;
        capabilityGapCounts.set(key, (capabilityGapCounts.get(key) ?? 0) + 1);
      }
    }
  }

  /**
   * Check model response text for capability gap patterns and emit demand if found.
   * Extracted from wrapModelCall/wrapModelStream to eliminate DRY violation.
   */
  function checkCapabilityGaps(responseText: string): void {
    if (patterns.length === 0) return;
    if (responseText.length === 0) return;

    updateGapCounts(responseText);

    const trigger = detectCapabilityGap(
      responseText,
      patterns,
      capabilityGapCounts,
      thresholds.capabilityGapOccurrences,
    );

    if (trigger !== undefined) {
      const gapKey = trigger.kind === "capability_gap" ? trigger.requiredCapability : "";
      emitSignal(trigger, {
        failureCount: capabilityGapCounts.get(gapKey) ?? 1,
        threshold: thresholds.capabilityGapOccurrences,
      });
    }
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
        // NOT_FOUND → tool never existed → emit no_matching_tool (not repeated_failure)
        if (e instanceof KoiRuntimeError && e.code === "NOT_FOUND") {
          const trigger: ForgeTrigger = {
            kind: "no_matching_tool",
            query: toolId,
            attempts: 1,
          };
          emitSignal(trigger, {
            failureCount: 1,
            threshold: thresholds.repeatedFailureCount,
          });
          checkLatencyDegradation(toolId);
          throw e;
        }

        // Other errors → record consecutive failure
        const count = (consecutiveFailures.get(toolId) ?? 0) + 1;
        consecutiveFailures.set(toolId, count);

        const calls = failedToolCalls.get(`rf:${toolId}`) ?? [];
        calls.push(extractMessage(e));
        // Cap at MAX_FAILED_CALL_MESSAGES to prevent unbounded memory growth
        if (calls.length > MAX_FAILED_CALL_MESSAGES) {
          calls.splice(0, calls.length - MAX_FAILED_CALL_MESSAGES);
        }
        failedToolCalls.set(`rf:${toolId}`, calls);

        // Check repeated failure heuristic
        const repeatedTrigger = detectRepeatedFailure(
          toolId,
          count,
          thresholds.repeatedFailureCount,
        );
        if (repeatedTrigger !== undefined) {
          emitSignal(repeatedTrigger, {
            failureCount: count,
            threshold: thresholds.repeatedFailureCount,
          });
        }

        checkLatencyDegradation(toolId);
        throw e;
      }

      // Success — reset consecutive failure counter and track tool sequence
      consecutiveFailures.set(toolId, 0);
      sessionToolCallCount++;
      lastToolCallId = toolId;
      if (!sessionToolSequence.includes(toolId)) {
        sessionToolSequence.push(toolId);
      }
      checkLatencyDegradation(toolId);

      return response;
    },

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      sessionTurnCount++;

      // Phase 2B: check user messages for correction patterns before model call
      if (correctionPatterns.length > 0 && lastToolCallId !== "") {
        for (const msg of request.messages) {
          if (msg.senderId === "system:ace" || msg.senderId === "system") continue;
          for (const block of msg.content) {
            if (block.kind !== "text") continue;
            const correctionTrigger = detectUserCorrection(
              block.text,
              correctionPatterns,
              lastToolCallId,
            );
            if (correctionTrigger !== undefined) {
              emitSignal(correctionTrigger, {
                failureCount: 1,
                threshold: 1,
              });
            }
          }
        }
      }

      const response = await next(request);
      checkCapabilityGaps(extractResponseText(response));
      return response;
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      sessionTurnCount++;

      // Phase 2B: check user messages for correction patterns before model call
      if (correctionPatterns.length > 0 && lastToolCallId !== "") {
        for (const msg of request.messages) {
          if (msg.senderId === "system:ace" || msg.senderId === "system") continue;
          for (const block of msg.content) {
            if (block.kind !== "text") continue;
            const correctionTrigger = detectUserCorrection(
              block.text,
              correctionPatterns,
              lastToolCallId,
            );
            if (correctionTrigger !== undefined) {
              emitSignal(correctionTrigger, {
                failureCount: 1,
                threshold: 1,
              });
            }
          }
        }
      }

      const chunks: string[] = [];
      for await (const chunk of next(request)) {
        if (chunk.kind === "text_delta") {
          chunks.push(chunk.delta);
        }
        yield chunk;
      }
      checkCapabilityGaps(chunks.join(""));
    },

    // Phase 2C: detect complex task completion and novel workflows at session end
    async onSessionEnd(_ctx: SessionContext): Promise<void> {
      // Complex task completion — emit if enough tool calls happened
      const complexTrigger = detectComplexTaskCompletion(
        sessionToolCallCount,
        sessionTurnCount,
        thresholds.complexTaskToolCallThreshold,
      );
      if (complexTrigger !== undefined) {
        emitSignal(complexTrigger, {
          failureCount: sessionToolCallCount,
          threshold: thresholds.complexTaskToolCallThreshold,
        });
      }

      // Novel workflow — emit if unique tool sequence is long enough
      const novelTrigger = detectNovelWorkflow(
        sessionToolSequence,
        thresholds.novelWorkflowMinLength,
      );
      if (novelTrigger !== undefined) {
        emitSignal(novelTrigger, {
          failureCount: sessionToolSequence.length,
          threshold: thresholds.novelWorkflowMinLength,
        });
      }

      // Reset session-scoped state
      sessionToolCallCount = 0;
      sessionTurnCount = 0;
      sessionToolSequence.length = 0;
      lastToolCallId = "";
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
