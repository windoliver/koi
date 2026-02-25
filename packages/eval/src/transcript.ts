/**
 * Transcript collection and extraction helpers.
 */

import type { EngineEvent, EngineMetrics } from "@koi/core";
import type { ToolCallSummary } from "./types.js";

/**
 * Collects all events from an async iterable into an array.
 */
export async function collectTranscript(
  stream: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  // Local mutable array for accumulation — not shared state
  const events: EngineEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/**
 * Extracts concatenated text from text_delta events.
 */
export function extractText(events: readonly EngineEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    if (event.kind === "text_delta") {
      parts.push(event.delta);
    }
  }
  return parts.join("");
}

/**
 * Extracts tool call summaries from tool_call_start events.
 */
export function extractToolCalls(events: readonly EngineEvent[]): readonly ToolCallSummary[] {
  const calls: ToolCallSummary[] = [];
  for (const event of events) {
    if (event.kind === "tool_call_start") {
      const base: ToolCallSummary = {
        toolName: event.toolName,
        callId: event.callId,
      };
      calls.push(event.args !== undefined ? { ...base, args: event.args } : base);
    }
  }
  return calls;
}

/**
 * Extracts metrics from events and measured duration.
 */
export function extractMetrics(events: readonly EngineEvent[], durationMs: number): EngineMetrics {
  const doneEvent = events.find((e) => e.kind === "done");
  if (doneEvent !== undefined && doneEvent.kind === "done") {
    return {
      ...doneEvent.output.metrics,
      durationMs,
    };
  }

  const turnCount = events.filter((e) => e.kind === "turn_end").length;

  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    turns: turnCount,
    durationMs,
  };
}

/**
 * Creates a brief text summary of a transcript.
 * Shows first message, tool call names, and last message.
 */
export function summarizeTranscript(events: readonly EngineEvent[]): string {
  const parts: string[] = [];

  const firstText = extractFirstText(events);
  if (firstText.length > 0) {
    parts.push(`Input: ${firstText.slice(0, 200)}`);
  }

  const toolCalls = extractToolCalls(events);
  if (toolCalls.length > 0) {
    const names = toolCalls.map((tc) => tc.toolName).join(", ");
    parts.push(`Tools: ${names}`);
  }

  const lastText = extractLastText(events);
  if (lastText.length > 0) {
    parts.push(`Output: ${lastText.slice(0, 200)}`);
  }

  return parts.join("\n");
}

/**
 * Returns the last N turn-bounded event groups.
 */
export function lastNTurns(events: readonly EngineEvent[], n: number): readonly EngineEvent[] {
  const turnStarts: number[] = [];
  for (const [i, event] of events.entries()) {
    if (event.kind === "turn_start") {
      turnStarts.push(i);
    }
  }

  if (turnStarts.length === 0) {
    return events.slice(-n);
  }

  const startFrom = turnStarts.length <= n ? 0 : turnStarts.length - n;
  const startIndex = turnStarts[startFrom];
  return startIndex !== undefined ? events.slice(startIndex) : events;
}

function extractFirstText(events: readonly EngineEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    if (event.kind === "text_delta") {
      parts.push(event.delta);
    }
    if (event.kind === "tool_call_start" || event.kind === "turn_end") {
      break;
    }
  }
  return parts.join("");
}

function extractLastText(events: readonly EngineEvent[]): string {
  const parts: string[] = [];
  // let justified: scanning backwards for the last text block
  let lastTurnStart = -1;
  for (const [i, event] of events.entries()) {
    if (event.kind === "turn_start") {
      lastTurnStart = i;
    }
  }

  const startIdx = lastTurnStart >= 0 ? lastTurnStart : 0;
  for (const event of events.slice(startIdx)) {
    if (event.kind === "text_delta") {
      parts.push(event.delta);
    }
  }
  return parts.join("");
}
