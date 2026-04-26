/**
 * Anomaly monitor — per-session, per-turn behavioral anomaly detection.
 *
 * Tracks tool call rate, error spikes, tool repetition, and denied calls.
 * Fires AnomalySignal values when thresholds are crossed, with per-turn
 * guards to prevent signal flooding.
 */

import type { AgentId, AnomalyBase, AnomalySignal, SessionId } from "@koi/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnomalyMonitorConfig {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  /** Max tool calls per turn before tool_rate_exceeded fires. Default: 10 */
  readonly toolRateThreshold?: number;
  /** Max errored tool calls per turn before error_spike fires. Default: 5 */
  readonly errorSpikeThreshold?: number;
  /** Max calls to the same tool per turn before tool_repeated fires. Default: 3 */
  readonly toolRepeatThreshold?: number;
  /** Max denied tool calls per turn before denied_tool_calls fires. Default: 3 */
  readonly deniedCallThreshold?: number;
}

export interface ToolCallEvent {
  readonly toolId: string;
  readonly denied?: boolean;
  readonly errored?: boolean;
}

export interface AnomalyMonitor {
  /** Record a tool call and return any anomaly signals produced. */
  readonly recordToolCall: (event: ToolCallEvent) => readonly AnomalySignal[];
  /** Advance to the next turn — resets per-turn counters and increments turnIndex. */
  readonly nextTurn: () => void;
  /** Reset all state back to initial — turnIndex returns to 0. */
  readonly reset: () => void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TOOL_RATE_THRESHOLD = 20;
const DEFAULT_ERROR_SPIKE_THRESHOLD = 5;
const DEFAULT_TOOL_REPEAT_THRESHOLD = 10;
const DEFAULT_DENIED_CALL_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAnomalyMonitor(config: AnomalyMonitorConfig): AnomalyMonitor {
  const { sessionId, agentId } = config;
  const toolRateThreshold = config.toolRateThreshold ?? DEFAULT_TOOL_RATE_THRESHOLD;
  const errorSpikeThreshold = config.errorSpikeThreshold ?? DEFAULT_ERROR_SPIKE_THRESHOLD;
  const toolRepeatThreshold = config.toolRepeatThreshold ?? DEFAULT_TOOL_REPEAT_THRESHOLD;
  const deniedCallThreshold = config.deniedCallThreshold ?? DEFAULT_DENIED_CALL_THRESHOLD;

  // Per-session state
  // mutable: reset by nextTurn() and reset()
  let turnIndex = 0;

  // Per-turn counters
  let callsThisTurn = 0;
  let errorsThisTurn = 0;
  let deniedThisTurn = 0;
  let toolCounts = new Map<string, number>();

  // Per-turn fired guards (prevent signal flooding within the same turn)
  let rateExceededFired = false;
  let errorSpikeFired = false;
  let deniedFired = false;
  const toolRepeatFired = new Set<string>();

  function makeBase(): AnomalyBase {
    return { sessionId, agentId, timestamp: Date.now(), turnIndex };
  }

  function resetTurn(): void {
    callsThisTurn = 0;
    errorsThisTurn = 0;
    deniedThisTurn = 0;
    toolCounts = new Map<string, number>();
    rateExceededFired = false;
    errorSpikeFired = false;
    deniedFired = false;
    toolRepeatFired.clear();
  }

  function recordToolCall(event: ToolCallEvent): readonly AnomalySignal[] {
    const signals: AnomalySignal[] = [];

    callsThisTurn += 1;

    if (event.errored === true) {
      errorsThisTurn += 1;
    }

    if (event.denied === true) {
      deniedThisTurn += 1;
    }

    const prevCount = toolCounts.get(event.toolId) ?? 0;
    const newCount = prevCount + 1;
    toolCounts.set(event.toolId, newCount);

    // tool_rate_exceeded — fires once when callsThisTurn first reaches threshold
    if (!rateExceededFired && callsThisTurn >= toolRateThreshold) {
      rateExceededFired = true;
      signals.push({
        ...makeBase(),
        kind: "tool_rate_exceeded",
        callsPerTurn: callsThisTurn,
        threshold: toolRateThreshold,
      } satisfies AnomalySignal);
    }

    // error_spike — fires once when errorsThisTurn first reaches threshold
    if (event.errored === true && !errorSpikeFired && errorsThisTurn >= errorSpikeThreshold) {
      errorSpikeFired = true;
      signals.push({
        ...makeBase(),
        kind: "error_spike",
        errorCount: errorsThisTurn,
        threshold: errorSpikeThreshold,
      } satisfies AnomalySignal);
    }

    // tool_repeated — fires once per tool when its count first reaches threshold
    if (!toolRepeatFired.has(event.toolId) && newCount >= toolRepeatThreshold) {
      toolRepeatFired.add(event.toolId);
      signals.push({
        ...makeBase(),
        kind: "tool_repeated",
        toolId: event.toolId,
        repeatCount: newCount,
        threshold: toolRepeatThreshold,
      } satisfies AnomalySignal);
    }

    // denied_tool_calls — fires once when deniedThisTurn first reaches threshold
    if (event.denied === true && !deniedFired && deniedThisTurn >= deniedCallThreshold) {
      deniedFired = true;
      signals.push({
        ...makeBase(),
        kind: "denied_tool_calls",
        deniedCount: deniedThisTurn,
        threshold: deniedCallThreshold,
      } satisfies AnomalySignal);
    }

    return signals;
  }

  function nextTurn(): void {
    turnIndex += 1;
    resetTurn();
  }

  function reset(): void {
    turnIndex = 0;
    resetTurn();
  }

  return { recordToolCall, nextTurn, reset };
}
