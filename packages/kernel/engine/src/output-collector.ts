/**
 * Output collectors — observe EngineEvent streams and extract agent output.
 *
 * Two implementations:
 * - `createVerdictCollector` — for hook agents: captures specific verdict tool output
 * - `createTextCollector` — for general agents: captures text deltas + last tool result
 */

import type { EngineEvent } from "@koi/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Non-throwing serialization of arbitrary tool output to string.
 * Returns the string as-is, serializes objects via JSON.stringify,
 * and catches circular references / BigInt / non-serializable values
 * so observe() never throws while streaming events.
 */
function safeSerialize(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? "[unserializable]" : json;
  } catch {
    return "[unserializable]";
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Stateful observer that accumulates output from an EngineEvent stream. */
export interface OutputCollector {
  readonly observe: (event: EngineEvent) => void;
  readonly output: () => string;
}

// ---------------------------------------------------------------------------
// Verdict collector (hook agents)
// ---------------------------------------------------------------------------

/**
 * Stateful verdict collector — captures the specific required tool's output
 * and ignores subsequent tool calls/text once the verdict is recorded.
 *
 * If no required tool is specified, falls back to collecting the last
 * tool_result output. Also accepts tool_call_end.result as a legacy
 * fallback for engine streams that haven't migrated to tool_result.
 */
export function createVerdictCollector(requiredToolName: string | undefined): OutputCollector {
  let verdictCaptured = false;
  let verdictOutput = "";
  let textBuffer = "";
  /** Track the tool name for legacy tool_call_end fallback. */
  let currentToolCallName: string | undefined;

  return {
    observe(event: EngineEvent): void {
      // Once we have the verdict, ignore everything else
      if (verdictCaptured) return;

      if (event.kind === "tool_call_start") {
        currentToolCallName = event.toolName;
        return;
      }

      // Prefer tool_result (carries real execution output).
      if (event.kind === "tool_result") {
        const isVerdictTool = requiredToolName !== undefined && event.toolName === requiredToolName;
        const serialized = safeSerialize(event.output);

        if (isVerdictTool) {
          verdictCaptured = true;
          verdictOutput = serialized;
          return;
        }

        if (requiredToolName === undefined) {
          verdictOutput = serialized;
        }
        return;
      }

      // Legacy fallback: engine streams that haven't migrated to tool_result
      // still carry executed output on tool_call_end.result.
      if (event.kind === "tool_call_end") {
        const isVerdictTool =
          requiredToolName !== undefined && currentToolCallName === requiredToolName;
        currentToolCallName = undefined;
        const serialized = safeSerialize(event.result);

        if (isVerdictTool) {
          verdictCaptured = true;
          verdictOutput = serialized;
          return;
        }

        if (requiredToolName === undefined) {
          verdictOutput = serialized;
        }
        return;
      }

      if (event.kind === "text_delta") {
        textBuffer += event.delta;
      }
    },

    output(): string {
      // Verdict from the required tool takes priority; fall back to text
      return verdictOutput.length > 0 ? verdictOutput : textBuffer;
    },
  };
}

// ---------------------------------------------------------------------------
// Text collector (general agent spawns)
// ---------------------------------------------------------------------------

/**
 * Simple text collector — accumulates text_delta events and falls back to
 * the last tool_result output. Also accepts tool_call_end.result as a
 * legacy fallback. No verdict logic, no required tool name.
 *
 * Used by `createAgentSpawnFn` for general agent-to-agent delegation.
 */
export function createTextCollector(): OutputCollector {
  let textBuffer = "";
  let lastToolResult = "";

  return {
    observe(event: EngineEvent): void {
      if (event.kind === "text_delta") {
        textBuffer += event.delta;
        return;
      }

      // Prefer tool_result (carries real execution output).
      if (event.kind === "tool_result") {
        lastToolResult = safeSerialize(event.output);
        return;
      }

      // Legacy fallback: engine streams that haven't migrated to tool_result.
      if (event.kind === "tool_call_end") {
        lastToolResult = safeSerialize(event.result);
        return;
      }

      // Fallback: extract text from the terminal done event when no deltas were
      // streamed (e.g. a child run that emits only a done event with batched content).
      if (event.kind === "done" && textBuffer.length === 0 && lastToolResult.length === 0) {
        for (const block of event.output.content) {
          if (block.kind === "text") {
            textBuffer += block.text;
          }
        }
      }
    },

    output(): string {
      // Text takes priority; fall back to last tool result
      return textBuffer.length > 0 ? textBuffer : lastToolResult;
    },
  };
}
