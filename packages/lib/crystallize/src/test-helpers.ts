import type { ToolCallId, TurnTrace } from "@koi/core";
import { sessionId } from "@koi/core";

/**
 * Build a `TurnTrace` from a tool-id sequence for tests. Use the
 * 3-arg variant to override per-tool output (default `{}` per tool).
 */
export function createTrace(turnIndex: number, toolIds: readonly string[]): TurnTrace;
export function createTrace(
  turnIndex: number,
  toolIds: readonly string[],
  outputs: readonly unknown[],
): TurnTrace;
export function createTrace(
  turnIndex: number,
  toolIds: readonly string[],
  outputs?: readonly unknown[],
): TurnTrace {
  return {
    turnIndex,
    sessionId: sessionId("test-session"),
    agentId: "test-agent",
    events: toolIds.map((toolId, i) => ({
      eventIndex: i,
      turnIndex,
      event: {
        kind: "tool_call" as const,
        toolId,
        callId: `call-${turnIndex}-${i}` as ToolCallId,
        input: {},
        output: outputs === undefined ? {} : outputs[i],
        durationMs: 10,
      },
      timestamp: 1000 + i,
    })),
    durationMs: toolIds.length * 10,
  };
}
