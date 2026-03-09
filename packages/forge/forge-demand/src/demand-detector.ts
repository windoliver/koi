/**
 * Forge demand detector middleware factory.
 *
 * Monitors tool calls and model responses for capability gaps,
 * repeated failures, and performance degradation. Emits ForgeDemandSignal
 * when patterns exceed configured thresholds.
 */

import type {
  BrickKind,
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
import type {
  ForgeDemandConfig,
  ForgeDemandHandle,
  HeuristicThresholds,
  RecoveryAnalyzer,
} from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_REPEATED_FAILURE_COUNT = 3;
const DEFAULT_CAPABILITY_GAP_OCCURRENCES = 2;
const DEFAULT_LATENCY_DEGRADATION_P95_MS = 5_000;
const DEFAULT_MAX_PENDING_SIGNALS = 10;
const DEFAULT_COMPLEX_TASK_TOOL_CALL_THRESHOLD = 5;
const DEFAULT_NOVEL_WORKFLOW_MIN_LENGTH = 3;

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
    case "complex_task_completed":
      return `ctc:${String(trigger.toolCallCount)}`;
    case "user_correction":
      return `uc:${trigger.correctedToolCall}`;
    case "novel_workflow":
      return `nw:${trigger.toolSequence.join(",")}`;
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
// Brick kind selection — maps trigger type to the appropriate brick kind
// ---------------------------------------------------------------------------

/**
 * Selects the appropriate brick kind based on trigger type.
 * Exhaustive switch — no default branch. Compiler catches missing cases.
 *
 * Phase 3A: when recoveryAnalyzer is provided, refines the kind based on
 * recovery trajectory. Terminal recovery → skill (with scripts);
 * single-step deterministic → tool; multi-step no-terminal → skill.
 */
function selectBrickKind(
  trigger: ForgeTrigger,
  recoveryAnalyzer?: RecoveryAnalyzer | undefined,
): BrickKind {
  const kind: ForgeTrigger["kind"] = trigger.kind;
  const baseKind = selectBaseKind(kind);

  // Phase 3A: refine based on recovery context (only for failure triggers)
  if (
    recoveryAnalyzer !== undefined &&
    (trigger.kind === "repeated_failure" || trigger.kind === "performance_degradation")
  ) {
    const toolId = trigger.toolName;
    const recovery = recoveryAnalyzer.analyzeRecovery(toolId);
    if (recovery?.succeeded) {
      // Terminal recovery → skill (needs scripts for procedural guidance)
      if (recovery.usedTerminal) return "skill";
      // Single-step deterministic recovery → tool
      if (recovery.stepCount === 1) return "tool";
      // Multi-step no-terminal → skill (instruction-only)
      return "skill";
    }
  }

  return baseKind;
}

/** Base kind mapping — pure, no recovery context. */
function selectBaseKind(kind: ForgeTrigger["kind"]): BrickKind {
  switch (kind) {
    // Knowledge gaps → skill (procedural knowledge, not executable code)
    case "repeated_failure":
    case "capability_gap":
    case "no_matching_tool":
      return "skill";

    // Performance → tool (deterministic optimization)
    case "performance_degradation":
      return "tool";

    // Agent-level gaps → agent
    case "agent_capability_gap":
    case "agent_repeated_failure":
    case "agent_latency_degradation":
      return "agent";

    // Success-side triggers → skill (capture learnings)
    case "complex_task_completed":
    case "user_correction":
    case "novel_workflow":
      return "skill";
  }
  // TypeScript exhaustiveness guard — triggers compile error if a case is missed
  const _exhaustive: never = kind;
  return _exhaustive;
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
      suggestedBrickKind: selectBrickKind(trigger, config.recoveryAnalyzer),
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
        const capability = match[0];
        capabilityGapCounts.set(capability, (capabilityGapCounts.get(capability) ?? 0) + 1);
      }
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

      // Fast path: no patterns configured
      if (patterns.length === 0) return response;

      const responseText = extractResponseText(response);
      if (responseText.length === 0) return response;

      // Always update gap counts first
      updateGapCounts(responseText);

      // Check capability gap patterns
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

      // Fast path: no patterns configured
      if (patterns.length === 0) return;

      const responseText = chunks.join("");
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
