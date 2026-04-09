/**
 * Output collectors — observe EngineEvent streams and extract agent output.
 *
 * Two implementations:
 * - `createVerdictCollector` — for hook agents: captures specific verdict tool output
 * - `createTextCollector` — for general agents: captures text deltas + last tool result
 */

import type { EngineEvent } from "@koi/core";

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
 * tool_result output (backward compat).
 *
 * NOTE: Reads from `tool_result.output` (the actual execution output) rather
 * than `tool_call_end.result` (which carries AccumulatedToolCall metadata —
 * args, not the real output). `tool_call_start` → `tool_call_end` tracks the
 * current tool name; `tool_result` provides the authoritative output.
 */
export function createVerdictCollector(requiredToolName: string | undefined): OutputCollector {
  let verdictCaptured = false;
  let verdictOutput = "";
  let textBuffer = "";
  /** Track the tool name for the current in-flight tool call. */
  let currentToolCallName: string | undefined;
  /** Track whether the current (or most-recent) call is the verdict tool. */
  let currentIsVerdictTool = false;

  return {
    observe(event: EngineEvent): void {
      // Once we have the verdict, ignore everything else
      if (verdictCaptured) return;

      if (event.kind === "tool_call_start") {
        currentToolCallName = event.toolName;
        currentIsVerdictTool =
          requiredToolName !== undefined && currentToolCallName === requiredToolName;
        return;
      }

      if (event.kind === "tool_call_end") {
        // tool_call_end only marks end of arg streaming — actual output arrives
        // via tool_result. Keep currentToolCallName so tool_result can still
        // associate the output with the right tool.
        return;
      }

      if (event.kind === "tool_result") {
        // tool_result carries the actual execution output.
        const output = event.output;
        const serialized =
          typeof output === "string"
            ? output
            : typeof output === "object" && output !== null
              ? JSON.stringify(output)
              : "";

        if (currentIsVerdictTool) {
          verdictCaptured = true;
          verdictOutput = serialized;
        } else if (requiredToolName === undefined) {
          // No required tool — track last output as fallback.
          verdictOutput = serialized;
        }
        currentToolCallName = undefined;
        currentIsVerdictTool = false;
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
 * the last tool_result output. No verdict logic, no required tool name.
 *
 * Used by `createAgentSpawnFn` for general agent-to-agent delegation.
 *
 * NOTE: Reads from `tool_result.output` (actual execution output), not
 * `tool_call_end.result` (AccumulatedToolCall metadata). Tool-only child
 * agents that finish with a tool call but no text need the real output.
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

      if (event.kind === "tool_result") {
        const output = event.output;
        if (typeof output === "string") {
          lastToolResult = output;
        } else if (typeof output === "object" && output !== null) {
          lastToolResult = JSON.stringify(output);
        }
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
