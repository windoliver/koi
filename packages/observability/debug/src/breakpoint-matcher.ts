/**
 * Pure function: evaluate a breakpoint predicate against an event context.
 *
 * Returns true if the predicate matches the current event/turn state.
 */

import type { BreakpointPredicate, EngineEvent } from "@koi/core";

// ---------------------------------------------------------------------------
// Event context for matching
// ---------------------------------------------------------------------------

export interface MatchContext {
  readonly event: EngineEvent;
  readonly turnIndex: number;
}

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

/** Evaluate whether a breakpoint predicate matches the given context. */
export function matchesBreakpoint(predicate: BreakpointPredicate, ctx: MatchContext): boolean {
  switch (predicate.kind) {
    case "turn": {
      if (ctx.event.kind !== "turn_start" && ctx.event.kind !== "turn_end") return false;
      if (predicate.turnIndex !== undefined) return ctx.turnIndex === predicate.turnIndex;
      if (predicate.every !== undefined && predicate.every > 0) {
        return ctx.turnIndex % predicate.every === 0;
      }
      return true;
    }

    case "tool_call": {
      if (ctx.event.kind !== "tool_call_start") return false;
      if (predicate.toolName !== undefined) return ctx.event.toolName === predicate.toolName;
      return true;
    }

    case "error": {
      // Match done events with error stop reason
      if (ctx.event.kind === "done" && ctx.event.output.stopReason === "error") return true;
      return false;
    }

    case "event_kind": {
      return ctx.event.kind === predicate.eventKind;
    }

    default: {
      const _exhaustive: never = predicate;
      throw new Error(`Unhandled breakpoint kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
