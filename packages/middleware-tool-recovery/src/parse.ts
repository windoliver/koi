/**
 * Core parse logic — orchestrates pattern matching and tool name validation.
 */

import type { ParsedToolCall, RecoveryEvent, RecoveryResult, ToolCallPattern } from "./types.js";

/**
 * Attempt to recover tool calls from model text output.
 *
 * Tries each pattern in order; the first pattern that matches wins.
 * Filters parsed tool calls against the allowed tools set and caps at maxCalls.
 * Returns undefined if no pattern matches or no valid tool calls are found.
 */
export function recoverToolCalls(
  text: string,
  patterns: readonly ToolCallPattern[],
  allowedTools: ReadonlySet<string>,
  maxCalls: number,
  onEvent?: (event: RecoveryEvent) => void,
): RecoveryResult | undefined {
  if (allowedTools.size === 0) return undefined;

  for (const pattern of patterns) {
    const result = pattern.detect(text);
    if (result === undefined) continue;

    // Filter against allowlist
    const accepted: ParsedToolCall[] = [];
    for (const call of result.toolCalls) {
      if (allowedTools.has(call.toolName)) {
        accepted.push(call);
      } else {
        onEvent?.({
          kind: "rejected",
          toolName: call.toolName,
          reason: `Tool "${call.toolName}" not in allowed tools set`,
        });
      }
    }

    if (accepted.length === 0) return undefined;

    // Cap at maxCalls
    const capped = accepted.length > maxCalls ? accepted.slice(0, maxCalls) : accepted;

    onEvent?.({
      kind: "recovered",
      pattern: pattern.name,
      toolCalls: capped,
    });

    return { toolCalls: capped, remainingText: result.remainingText };
  }

  return undefined;
}
