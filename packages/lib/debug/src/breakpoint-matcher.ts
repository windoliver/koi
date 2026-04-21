import type { BreakpointPredicate, EngineEvent } from "@koi/core";

export interface MatchContext {
  readonly event: EngineEvent;
  readonly turnIndex: number;
}

/** Evaluate whether a breakpoint predicate matches the given context. */
export function matchesBreakpoint(predicate: BreakpointPredicate, ctx: MatchContext): boolean {
  switch (predicate.kind) {
    case "turn": {
      if (ctx.event.kind !== "turn_start") return false;
      if (predicate.turnIndex !== undefined) return ctx.turnIndex === predicate.turnIndex;
      if (predicate.every !== undefined) {
        // every <= 0 is invalid — never matches
        return predicate.every > 0 && ctx.turnIndex % predicate.every === 0;
      }
      return true;
    }

    case "tool_call": {
      // Match on two distinct points:
      //   1. tool_call_start — runtime EXECUTED tool call (post security guards)
      //   2. custom model_tool_call_announced — model ANNOUNCED tool call,
      //      visible before intercept-tier guards can deny it (important for
      //      debugging denied/blocked tool calls that never reach execution).
      if (ctx.event.kind === "tool_call_start") {
        if (predicate.toolName !== undefined) return ctx.event.toolName === predicate.toolName;
        return true;
      }
      if (ctx.event.kind === "custom" && ctx.event.type === "model_tool_call_announced") {
        if (predicate.toolName !== undefined) {
          const data = ctx.event.data as { toolName?: string } | undefined;
          return data?.toolName === predicate.toolName;
        }
        return true;
      }
      return false;
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
