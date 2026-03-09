/**
 * Pure detection functions for forge demand triggers.
 *
 * Each heuristic is independently testable — no side effects, no state.
 * Follows the computeHealthAction pattern from tool-health.ts.
 */

import type {
  BrickId,
  ForgeTrigger,
  KoiError,
  Result,
  TaskableAgent,
  ToolHealthSnapshot,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Default capability gap regex patterns
// ---------------------------------------------------------------------------

/** Model response patterns indicating the LLM cannot find a suitable tool. */
export const DEFAULT_CAPABILITY_GAP_PATTERNS: readonly RegExp[] = [
  /I don'?t have (?:a |any )?tool/i,
  /no (?:available |suitable )?tool (?:for|to|that)/i,
  /I(?:'m| am) unable to .+ because .+ (?:tool|capability)/i,
  /I lack the (?:tool|capability|ability) to/i,
  /there (?:is|are) no (?:tool|function)s? (?:available )?(?:for|to)/i,
];

// ---------------------------------------------------------------------------
// Repeated failure detection
// ---------------------------------------------------------------------------

/**
 * Detect repeated failure demand when consecutive failures exceed threshold.
 *
 * @param toolId - The tool that is failing.
 * @param consecutiveFailures - Number of consecutive failures observed.
 * @param threshold - Minimum failures to trigger demand.
 * @returns ForgeTrigger if threshold met, undefined otherwise.
 */
export function detectRepeatedFailure(
  toolId: string,
  consecutiveFailures: number,
  threshold: number,
): ForgeTrigger | undefined {
  if (consecutiveFailures < threshold) return undefined;
  return {
    kind: "repeated_failure",
    toolName: toolId,
    count: consecutiveFailures,
  };
}

// ---------------------------------------------------------------------------
// Capability gap detection
// ---------------------------------------------------------------------------

/**
 * Detect capability gap from model response text matching known patterns.
 *
 * @param responseText - The model's text response.
 * @param patterns - Regex patterns indicating capability gaps.
 * @param gapCounts - Running count of gap detections per capability key.
 * @param threshold - Minimum occurrences before triggering.
 * @returns ForgeTrigger if gap detected and threshold met, undefined otherwise.
 */
export function detectCapabilityGap(
  responseText: string,
  patterns: readonly RegExp[],
  gapCounts: ReadonlyMap<string, number>,
  threshold: number,
): ForgeTrigger | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(responseText);
    if (match !== null) {
      const capability = match[0];
      const count = gapCounts.get(capability) ?? 0;
      if (count >= threshold) {
        return {
          kind: "capability_gap",
          requiredCapability: capability,
        };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Latency degradation detection
// ---------------------------------------------------------------------------

/**
 * Detect latency degradation from health snapshot metrics.
 *
 * @param toolId - The tool to check.
 * @param healthSnapshot - Current health snapshot (undefined if not tracked).
 * @param p95ThresholdMs - Maximum acceptable average latency in ms.
 * @returns ForgeTrigger if degradation detected, undefined otherwise.
 */
export function detectLatencyDegradation(
  toolId: string,
  healthSnapshot: ToolHealthSnapshot | undefined,
  p95ThresholdMs: number,
): ForgeTrigger | undefined {
  if (healthSnapshot === undefined) return undefined;
  if (healthSnapshot.metrics.usageCount === 0) return undefined;
  if (healthSnapshot.metrics.avgLatencyMs <= p95ThresholdMs) return undefined;

  return {
    kind: "performance_degradation",
    toolName: toolId,
    metric: `avgLatencyMs=${String(Math.round(healthSnapshot.metrics.avgLatencyMs))}`,
  };
}

// ---------------------------------------------------------------------------
// User correction detection
// ---------------------------------------------------------------------------

/** Default patterns indicating the user is correcting the agent's behavior. */
export const DEFAULT_USER_CORRECTION_PATTERNS: readonly RegExp[] = [
  /(?:no,? )?that'?s (?:not (?:quite )?right|wrong|incorrect)/i,
  /(?:actually|instead),? (?:you should|use|try)/i,
  /(?:don'?t|do not|stop) (?:do(?:ing)?|use|using) (?:that|this)/i,
  /I (?:said|meant|wanted|asked for)/i,
  /let me (?:correct|fix|clarify)/i,
];

/**
 * Detect user correction patterns in a user message.
 *
 * @param userText - The user's message text.
 * @param patterns - Regex patterns indicating corrections.
 * @param recentToolCall - The most recent tool call that may have been corrected.
 * @returns ForgeTrigger if correction detected, undefined otherwise.
 */
export function detectUserCorrection(
  userText: string,
  patterns: readonly RegExp[],
  recentToolCall: string,
): ForgeTrigger | undefined {
  for (const pattern of patterns) {
    if (pattern.test(userText)) {
      return {
        kind: "user_correction",
        correctionText: userText.slice(0, 200),
        correctedToolCall: recentToolCall,
      };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Complex task completion detection
// ---------------------------------------------------------------------------

/**
 * Detect complex task completion when tool call count exceeds threshold.
 *
 * @param toolCallCount - Total tool calls in the session.
 * @param turnCount - Total turns in the session.
 * @param threshold - Minimum tool calls to consider "complex". Default: 5.
 * @returns ForgeTrigger if threshold met, undefined otherwise.
 */
export function detectComplexTaskCompletion(
  toolCallCount: number,
  turnCount: number,
  threshold: number,
): ForgeTrigger | undefined {
  if (toolCallCount < threshold) return undefined;
  return {
    kind: "complex_task_completed",
    toolCallCount,
    turnCount,
  };
}

// ---------------------------------------------------------------------------
// Novel workflow detection
// ---------------------------------------------------------------------------

/**
 * Detect novel tool sequences that haven't been seen before.
 *
 * @param toolSequence - Ordered list of tool IDs called this session.
 * @param minLength - Minimum sequence length to consider. Default: 3.
 * @returns ForgeTrigger if novel sequence detected, undefined otherwise.
 */
export function detectNovelWorkflow(
  toolSequence: readonly string[],
  minLength: number,
): ForgeTrigger | undefined {
  if (toolSequence.length < minLength) return undefined;
  return {
    kind: "novel_workflow",
    toolSequence,
  };
}

// ---------------------------------------------------------------------------
// Agent-level heuristics
// ---------------------------------------------------------------------------

/**
 * Detect agent capability gap when resolver returns NOT_FOUND.
 *
 * @param agentType - The requested agent type that was not found.
 * @param resolveResult - The result from AgentResolver.resolve().
 * @returns ForgeTrigger if resolve returned NOT_FOUND, undefined otherwise.
 */
export function detectAgentCapabilityGap(
  agentType: string,
  resolveResult: Result<TaskableAgent, KoiError>,
): ForgeTrigger | undefined {
  if (resolveResult.ok) return undefined;
  if (resolveResult.error.code !== "NOT_FOUND") return undefined;
  return { kind: "agent_capability_gap", agentType };
}

/**
 * Detect repeated failure for an agent brick when error rate exceeds threshold.
 *
 * @param agentType - The agent type being monitored.
 * @param brickId - The specific brick being checked.
 * @param healthSnapshot - Current health snapshot for the brick.
 * @param threshold - Error rate threshold (0-1) to trigger demand.
 * @param minSamples - Minimum usage count before checking (default: 5).
 * @returns ForgeTrigger if error rate exceeds threshold, undefined otherwise.
 */
export function detectAgentRepeatedFailure(
  agentType: string,
  brickId: BrickId,
  healthSnapshot: ToolHealthSnapshot | undefined,
  threshold: number,
  minSamples: number = 5,
): ForgeTrigger | undefined {
  if (healthSnapshot === undefined) return undefined;
  if (healthSnapshot.metrics.usageCount < minSamples) return undefined;
  if (healthSnapshot.metrics.errorRate < threshold) return undefined;

  return {
    kind: "agent_repeated_failure",
    agentType,
    brickId,
    errorRate: healthSnapshot.metrics.errorRate,
  };
}

/**
 * Detect latency degradation for an agent brick when P95 exceeds threshold.
 *
 * @param agentType - The agent type being monitored.
 * @param brickId - The specific brick being checked.
 * @param healthSnapshot - Current health snapshot for the brick.
 * @param p95ThresholdMs - Maximum acceptable average latency in ms.
 * @returns ForgeTrigger if latency exceeds threshold, undefined otherwise.
 */
export function detectAgentLatencyDegradation(
  agentType: string,
  brickId: BrickId,
  healthSnapshot: ToolHealthSnapshot | undefined,
  p95ThresholdMs: number,
): ForgeTrigger | undefined {
  if (healthSnapshot === undefined) return undefined;
  if (healthSnapshot.metrics.usageCount === 0) return undefined;
  if (healthSnapshot.metrics.avgLatencyMs <= p95ThresholdMs) return undefined;

  return {
    kind: "agent_latency_degradation",
    agentType,
    brickId,
    p95Ms: healthSnapshot.metrics.avgLatencyMs,
  };
}
