import type { BreakpointPredicate, EngineEvent } from "@koi/core";

export interface MatchContext {
  readonly event: EngineEvent;
  readonly turnIndex: number;
}

/** Evaluate whether a breakpoint predicate matches the given context. */
export function matchesBreakpoint(predicate: BreakpointPredicate, ctx: MatchContext): boolean {
  switch (predicate.kind) {
    case "turn": {
      if (ctx.event.kind !== "turn_start" && ctx.event.kind !== "turn_end") return false;
      if (predicate.turnIndex !== undefined) return ctx.turnIndex === predicate.turnIndex;
      if (predicate.every !== undefined) {
        // every <= 0 is invalid — never matches
        return predicate.every > 0 && ctx.turnIndex % predicate.every === 0;
      }
      return true;
    }

    case "tool_call": {
      if (ctx.event.kind !== "tool_call_start") return false;
      if (predicate.toolName !== undefined) return ctx.event.toolName === predicate.toolName;
      return true;
    }

    case "error": {
      return ctx.event.kind === "done" && ctx.event.output.stopReason === "error";
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
