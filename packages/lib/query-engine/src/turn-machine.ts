/**
 * Turn state machine — pure transition function.
 *
 * States: idle → model → tool_execution → continue → model (loop)
 *                                                  → complete (done)
 *               → complete (text-only / error / abort)
 *
 * All transitions are pure: transitionTurn(state, input) → new state.
 * Invalid transitions throw — bugs are immediately visible.
 */

import type { EngineStopReason } from "@koi/core";

// ---------------------------------------------------------------------------
// Turn phases
// ---------------------------------------------------------------------------

export type TurnPhase = "idle" | "model" | "tool_execution" | "continue" | "complete";

// ---------------------------------------------------------------------------
// Turn inputs (events that drive transitions)
// ---------------------------------------------------------------------------

export type TurnInput =
  | { readonly kind: "start" }
  | { readonly kind: "model_done"; readonly hasToolCalls: boolean }
  | { readonly kind: "tools_done" }
  | { readonly kind: "abort" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "max_turns" };

// ---------------------------------------------------------------------------
// Turn state
// ---------------------------------------------------------------------------

export interface TurnState {
  readonly phase: TurnPhase;
  readonly turnIndex: number;
  readonly modelCalls: number;
  readonly stopReason: EngineStopReason | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTurnState(turnIndex: number = 0): TurnState {
  return { phase: "idle", turnIndex, modelCalls: 0, stopReason: undefined };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function complete(state: TurnState, stopReason: EngineStopReason): TurnState {
  return { ...state, phase: "complete", stopReason };
}

function invalidTransition(phase: TurnPhase, inputKind: string): never {
  throw new Error(`Invalid turn transition: "${phase}" + "${inputKind}"`);
}

// ---------------------------------------------------------------------------
// Pure transition function
// ---------------------------------------------------------------------------

export function transitionTurn(state: TurnState, input: TurnInput): TurnState {
  switch (state.phase) {
    case "idle": {
      if (input.kind === "start") {
        return { ...state, phase: "model", modelCalls: state.modelCalls + 1 };
      }
      return invalidTransition(state.phase, input.kind);
    }

    case "model": {
      switch (input.kind) {
        case "model_done":
          return input.hasToolCalls
            ? { ...state, phase: "tool_execution" }
            : complete(state, "completed");
        case "abort":
          return complete(state, "interrupted");
        case "error":
          return complete(state, "error");
        default:
          return invalidTransition(state.phase, input.kind);
      }
    }

    case "tool_execution": {
      switch (input.kind) {
        case "tools_done":
          return { ...state, phase: "continue", turnIndex: state.turnIndex + 1 };
        case "abort":
          return complete(state, "interrupted");
        case "error":
          return complete(state, "error");
        default:
          return invalidTransition(state.phase, input.kind);
      }
    }

    case "continue": {
      switch (input.kind) {
        case "start":
          return { ...state, phase: "model", modelCalls: state.modelCalls + 1 };
        case "max_turns":
          return complete(state, "max_turns");
        case "abort":
          return complete(state, "interrupted");
        default:
          return invalidTransition(state.phase, input.kind);
      }
    }

    case "complete":
      return invalidTransition(state.phase, input.kind);

    default: {
      const _exhaustive: never = state.phase;
      throw new Error(`Unhandled phase: ${_exhaustive}`);
    }
  }
}
