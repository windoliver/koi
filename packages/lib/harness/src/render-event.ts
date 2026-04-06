/**
 * EngineEvent → string rendering for raw-stdout mode.
 *
 * Pure functions — no side effects, no I/O. The harness calls shouldRender()
 * before renderEngineEvent() to avoid string allocation for silent events.
 */

import type { EngineEvent } from "@koi/core";

/**
 * Returns true when the event should produce visible output in the given mode.
 * Call this BEFORE renderEngineEvent() to skip allocation for silent events.
 */
export function shouldRender(event: EngineEvent, verbose: boolean): boolean {
  switch (event.kind) {
    case "text_delta":
    case "done":
      return true;
    case "thinking_delta":
    case "tool_call_start":
    case "tool_call_end":
    case "turn_start":
    case "turn_end":
      return verbose;
    case "tool_call_delta":
    case "custom":
    case "discovery:miss":
    case "spawn_requested":
    case "agent_spawned":
    case "agent_status_changed":
    case "permission_attempt":
      return false;
    default: {
      // Exhaustive — new EngineEvent kinds will cause a compile error here.
      const _: never = event;
      return false;
    }
  }
}

/**
 * Convert an EngineEvent to a display string, or null if the event is silent.
 *
 * Always call shouldRender() first; this function may still return null
 * for edge cases (e.g. empty deltas).
 *
 * @param hasPriorDeltas - When true, the caller already streamed text_delta
 *   chunks for this turn. For `done` events, this suppresses re-rendering the
 *   same content from `done.output.content` to avoid duplication.
 */
export function renderEngineEvent(
  event: EngineEvent,
  verbose: boolean,
  hasPriorDeltas = false,
): string | null {
  switch (event.kind) {
    case "text_delta":
      return event.delta.length > 0 ? event.delta : null;
    case "thinking_delta":
      return verbose && event.delta.length > 0 ? `\x1b[2m[thinking] ${event.delta}\x1b[0m` : null;
    case "tool_call_start":
      return verbose ? `\x1b[33m[tool: ${event.toolName}]\x1b[0m ` : null;
    case "tool_call_end":
      return verbose ? `\x1b[2m✓\x1b[0m\n` : null;
    case "turn_start":
      return verbose ? `\x1b[2m--- turn ${event.turnIndex + 1} ---\x1b[0m\n` : null;
    case "turn_end":
      return verbose ? `\n` : null;
    case "done": {
      // When deltas were already streamed, only append the trailing newline.
      // When no deltas were emitted (non-streaming engine), render the
      // authoritative done.output.content text so the reply isn't blank.
      if (hasPriorDeltas) return "\n";
      const textBlocks = event.output.content
        .filter((b) => b.kind === "text")
        .map((b) => (b as { readonly kind: "text"; readonly text: string }).text)
        .join("");
      return textBlocks.length > 0 ? `${textBlocks}\n` : "\n";
    }
    default:
      return null;
  }
}
