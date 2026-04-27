/**
 * Pure detection functions for forge demand triggers.
 *
 * Each heuristic is independently testable — no side effects, no state.
 */

import type { ForgeTrigger, ToolHealthSnapshot } from "@koi/core";

// ---------------------------------------------------------------------------
// Default regex patterns
// ---------------------------------------------------------------------------

/** Model response patterns indicating the LLM cannot find a suitable tool. */
export const DEFAULT_CAPABILITY_GAP_PATTERNS: readonly RegExp[] = [
  /I don'?t (?:currently )?have (?:a |any )?\w* ?tool/i,
  /no (?:available |suitable )?\w* ?tool (?:for|to|that|in)/i,
  /I(?:'m| am) unable to .+ because .+ (?:tool|capability)/i,
  /I lack the (?:tool|capability|ability) to/i,
  /there (?:is|are) no (?:tool|function)s? (?:available )?(?:for|to)/i,
];

/** Default patterns indicating the user is correcting the agent's behavior. */
export const DEFAULT_USER_CORRECTION_PATTERNS: readonly RegExp[] = [
  /(?:no,? )?that'?s (?:not (?:quite )?right|wrong|incorrect)/i,
  /(?:actually|instead),? (?:you should|use|try)/i,
  /(?:don'?t|do not|stop) (?:do(?:ing)?|use|using) (?:that|this)/i,
  /I (?:said|meant|wanted|asked for)/i,
  /let me (?:correct|fix|clarify)/i,
];

// ---------------------------------------------------------------------------
// Repeated failure
// ---------------------------------------------------------------------------

/**
 * Detect repeated failure demand when consecutive failures meet threshold.
 * Returns trigger if `consecutiveFailures >= threshold`, else `undefined`.
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
// Capability gap
// ---------------------------------------------------------------------------

/**
 * Detect capability gap from model response text.
 *
 * Looks for the first matching pattern whose accumulated count meets the
 * threshold, returning the matched substring as `requiredCapability`.
 */
export function detectCapabilityGap(
  responseText: string,
  patterns: readonly RegExp[],
  gapCounts: ReadonlyMap<string, number>,
  threshold: number,
): ForgeTrigger | undefined {
  for (const pattern of patterns) {
    // Defensive: reset stateful flags so detection cannot depend on
    // prior traffic if a `g`/`y` pattern slipped past validation.
    pattern.lastIndex = 0;
    const match = pattern.exec(responseText);
    if (match !== null) {
      const count = gapCounts.get(pattern.source) ?? 0;
      if (count >= threshold) {
        return { kind: "capability_gap", requiredCapability: match[0] };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Latency degradation
// ---------------------------------------------------------------------------

/**
 * Detect latency degradation when the average exceeds the threshold.
 * Returns `undefined` if the snapshot has no usage or is below threshold.
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
// User correction
// ---------------------------------------------------------------------------

/**
 * Detect user correction patterns in a user message.
 * Returns a `user_correction` trigger when any pattern matches.
 */
export function detectUserCorrection(
  userText: string,
  patterns: readonly RegExp[],
  recentToolCall: string,
): ForgeTrigger | undefined {
  for (const pattern of patterns) {
    // Defensive: reset stateful flags (see detectCapabilityGap above).
    pattern.lastIndex = 0;
    if (pattern.test(userText)) {
      const correctionText = userText.slice(0, 200);
      return {
        kind: "user_correction",
        correctionText,
        correctedToolCall: recentToolCall,
        correctionDescription: correctionText,
        originalToolName: recentToolCall,
      };
    }
  }
  return undefined;
}
