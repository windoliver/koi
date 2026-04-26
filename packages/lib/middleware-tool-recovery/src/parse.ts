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

    if (accepted.length > maxCalls) {
      // Fail closed: a model that emits more calls than the configured cap
      // is in an unexpected state. Reject the entire batch and surface
      // `rejected` events for every call so the caller can re-prompt or
      // log; do NOT silently drop the over-cap calls while executing the
      // first N — that creates partial-failure states that are hard to
      // recover from idempotently.
      for (const call of accepted) {
        onEvent?.({
          kind: "rejected",
          toolName: call.toolName,
          reason: `Recovered ${String(accepted.length)} tool calls exceeds maxToolCallsPerResponse=${String(maxCalls)} — entire batch rejected`,
        });
      }
      return undefined;
    }

    onEvent?.({ kind: "recovered", pattern: pattern.name, toolCalls: accepted });

    return { toolCalls: accepted, remainingText: result.remainingText };
  }

  return undefined;
}
