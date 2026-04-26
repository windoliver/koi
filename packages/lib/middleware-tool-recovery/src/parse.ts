/**
 * Core parse logic — orchestrates pattern matching and tool name validation.
 *
 * Tries each pattern in order; the first pattern that returns at least one
 * allowed tool call wins. Filters parsed tool calls against the request's
 * tool-name allowlist and caps at `maxCalls`.
 */

import type { ParsedToolCall, RecoveryEvent, RecoveryResult, ToolCallPattern } from "./types.js";

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

    if (accepted.length === 0) continue;

    const capped = accepted.length > maxCalls ? accepted.slice(0, maxCalls) : accepted;

    onEvent?.({ kind: "recovered", pattern: pattern.name, toolCalls: capped });

    return { toolCalls: capped, remainingText: result.remainingText };
  }

  return undefined;
}
