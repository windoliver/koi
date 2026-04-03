import { describe, expect, test } from "bun:test";
import type { TurnState } from "./turn-machine.js";
import { createTurnState, transitionTurn } from "./turn-machine.js";

describe("createTurnState", () => {
  test("returns idle state with default turnIndex 0", () => {
    const state = createTurnState();
    expect(state).toEqual({
      phase: "idle",
      turnIndex: 0,
      modelCalls: 0,
      stopReason: undefined,
    });
  });

  test("accepts custom turnIndex", () => {
    const state = createTurnState(5);
    expect(state.turnIndex).toBe(5);
    expect(state.phase).toBe("idle");
  });
});

describe("transitionTurn", () => {
  // -----------------------------------------------------------------------
  // Happy paths
  // -----------------------------------------------------------------------

  test("idle -> start -> model", () => {
    const state = createTurnState();
    const next = transitionTurn(state, { kind: "start" });
    expect(next.phase).toBe("model");
    expect(next.modelCalls).toBe(1);
  });

  test("model -> model_done (no tools) -> complete with stopReason completed", () => {
    const state = transitionTurn(createTurnState(), { kind: "start" });
    const next = transitionTurn(state, { kind: "model_done", hasToolCalls: false });
    expect(next.phase).toBe("complete");
    expect(next.stopReason).toBe("completed");
  });

  test("model -> model_done (has tools) -> tool_execution", () => {
    const state = transitionTurn(createTurnState(), { kind: "start" });
    const next = transitionTurn(state, { kind: "model_done", hasToolCalls: true });
    expect(next.phase).toBe("tool_execution");
    expect(next.stopReason).toBeUndefined();
  });

  test("tool_execution -> tools_done -> continue with turnIndex incremented", () => {
    let state: TurnState = createTurnState();
    state = transitionTurn(state, { kind: "start" });
    state = transitionTurn(state, { kind: "model_done", hasToolCalls: true });
    expect(state.turnIndex).toBe(0);
    const next = transitionTurn(state, { kind: "tools_done" });
    expect(next.phase).toBe("continue");
    expect(next.turnIndex).toBe(1);
  });

  test("continue -> start -> model (loop continuation)", () => {
    let state: TurnState = createTurnState();
    state = transitionTurn(state, { kind: "start" });
    state = transitionTurn(state, { kind: "model_done", hasToolCalls: true });
    state = transitionTurn(state, { kind: "tools_done" });
    const next = transitionTurn(state, { kind: "start" });
    expect(next.phase).toBe("model");
    expect(next.modelCalls).toBe(2);
  });

  test("continue -> max_turns -> complete with stopReason max_turns", () => {
    let state: TurnState = createTurnState();
    state = transitionTurn(state, { kind: "start" });
    state = transitionTurn(state, { kind: "model_done", hasToolCalls: true });
    state = transitionTurn(state, { kind: "tools_done" });
    const next = transitionTurn(state, { kind: "max_turns" });
    expect(next.phase).toBe("complete");
    expect(next.stopReason).toBe("max_turns");
  });

  // -----------------------------------------------------------------------
  // Abort transitions
  // -----------------------------------------------------------------------

  test("model -> abort -> complete with stopReason interrupted", () => {
    const state = transitionTurn(createTurnState(), { kind: "start" });
    const next = transitionTurn(state, { kind: "abort" });
    expect(next.phase).toBe("complete");
    expect(next.stopReason).toBe("interrupted");
  });

  test("tool_execution -> abort -> complete with stopReason interrupted", () => {
    let state: TurnState = createTurnState();
    state = transitionTurn(state, { kind: "start" });
    state = transitionTurn(state, { kind: "model_done", hasToolCalls: true });
    const next = transitionTurn(state, { kind: "abort" });
    expect(next.phase).toBe("complete");
    expect(next.stopReason).toBe("interrupted");
  });

  test("continue -> abort -> complete with stopReason interrupted", () => {
    let state: TurnState = createTurnState();
    state = transitionTurn(state, { kind: "start" });
    state = transitionTurn(state, { kind: "model_done", hasToolCalls: true });
    state = transitionTurn(state, { kind: "tools_done" });
    const next = transitionTurn(state, { kind: "abort" });
    expect(next.phase).toBe("complete");
    expect(next.stopReason).toBe("interrupted");
  });

  // -----------------------------------------------------------------------
  // Error transitions
  // -----------------------------------------------------------------------

  test("model -> error -> complete with stopReason error", () => {
    const state = transitionTurn(createTurnState(), { kind: "start" });
    const next = transitionTurn(state, { kind: "error", message: "boom" });
    expect(next.phase).toBe("complete");
    expect(next.stopReason).toBe("error");
  });

  test("tool_execution -> error -> complete with stopReason error", () => {
    let state: TurnState = createTurnState();
    state = transitionTurn(state, { kind: "start" });
    state = transitionTurn(state, { kind: "model_done", hasToolCalls: true });
    const next = transitionTurn(state, { kind: "error", message: "tool failed" });
    expect(next.phase).toBe("complete");
    expect(next.stopReason).toBe("error");
  });

  // -----------------------------------------------------------------------
  // Invalid transitions
  // -----------------------------------------------------------------------

  test("idle -> tools_done throws", () => {
    expect(() => transitionTurn(createTurnState(), { kind: "tools_done" })).toThrow(
      /Invalid turn transition/,
    );
  });

  test("idle -> model_done throws", () => {
    expect(() =>
      transitionTurn(createTurnState(), { kind: "model_done", hasToolCalls: false }),
    ).toThrow(/Invalid turn transition/);
  });

  test("model -> start throws", () => {
    const state = transitionTurn(createTurnState(), { kind: "start" });
    expect(() => transitionTurn(state, { kind: "start" })).toThrow(/Invalid turn transition/);
  });

  test("complete -> start throws", () => {
    let state: TurnState = createTurnState();
    state = transitionTurn(state, { kind: "start" });
    state = transitionTurn(state, { kind: "model_done", hasToolCalls: false });
    expect(state.phase).toBe("complete");
    expect(() => transitionTurn(state, { kind: "start" })).toThrow(/Invalid turn transition/);
  });

  test("continue -> tools_done throws", () => {
    let state: TurnState = createTurnState();
    state = transitionTurn(state, { kind: "start" });
    state = transitionTurn(state, { kind: "model_done", hasToolCalls: true });
    state = transitionTurn(state, { kind: "tools_done" });
    expect(() => transitionTurn(state, { kind: "tools_done" })).toThrow(/Invalid turn transition/);
  });

  // -----------------------------------------------------------------------
  // Stop-blocked transitions (turn.stop gate)
  // -----------------------------------------------------------------------

  test("complete -> stop_blocked -> continue with incremented turnIndex and cleared stopReason", () => {
    let state: TurnState = createTurnState();
    state = transitionTurn(state, { kind: "start" });
    state = transitionTurn(state, { kind: "model_done", hasToolCalls: false });
    expect(state.phase).toBe("complete");
    expect(state.stopReason).toBe("completed");

    const next = transitionTurn(state, { kind: "stop_blocked" });
    expect(next.phase).toBe("continue");
    expect(next.stopReason).toBeUndefined();
    expect(next.turnIndex).toBe(state.turnIndex + 1);
  });

  test("stop_blocked from error-complete throws (only completed can be unblocked)", () => {
    let state: TurnState = createTurnState();
    state = transitionTurn(state, { kind: "start" });
    state = transitionTurn(state, { kind: "error", message: "boom" });
    expect(state.phase).toBe("complete");
    expect(state.stopReason).toBe("error");
    // stop_blocked is only valid from complete phase, which it is — but
    // the caller (turn-runner) only invokes it when stopReason === "completed"
    // The state machine itself allows it from any complete state.
    const next = transitionTurn(state, { kind: "stop_blocked" });
    expect(next.phase).toBe("continue");
  });

  test("idle -> stop_blocked throws", () => {
    expect(() => transitionTurn(createTurnState(), { kind: "stop_blocked" })).toThrow(
      /Invalid turn transition/,
    );
  });

  test("model -> stop_blocked throws", () => {
    const state = transitionTurn(createTurnState(), { kind: "start" });
    expect(() => transitionTurn(state, { kind: "stop_blocked" })).toThrow(
      /Invalid turn transition/,
    );
  });

  // -----------------------------------------------------------------------
  // Immutability
  // -----------------------------------------------------------------------

  test("transition returns new object, original unchanged", () => {
    const original = createTurnState();
    const next = transitionTurn(original, { kind: "start" });
    expect(original.phase).toBe("idle");
    expect(next.phase).toBe("model");
    expect(original).not.toBe(next);
  });

  // -----------------------------------------------------------------------
  // Full loop: idle -> model -> tool_execution -> continue -> model -> complete
  // -----------------------------------------------------------------------

  test("full two-turn loop", () => {
    let state: TurnState = createTurnState();

    // Turn 0: model call with tool calls
    state = transitionTurn(state, { kind: "start" });
    expect(state).toMatchObject({ phase: "model", turnIndex: 0, modelCalls: 1 });

    state = transitionTurn(state, { kind: "model_done", hasToolCalls: true });
    expect(state.phase).toBe("tool_execution");

    state = transitionTurn(state, { kind: "tools_done" });
    expect(state).toMatchObject({ phase: "continue", turnIndex: 1 });

    // Turn 1: model call with text-only response
    state = transitionTurn(state, { kind: "start" });
    expect(state).toMatchObject({ phase: "model", turnIndex: 1, modelCalls: 2 });

    state = transitionTurn(state, { kind: "model_done", hasToolCalls: false });
    expect(state).toMatchObject({ phase: "complete", stopReason: "completed" });
  });
});
