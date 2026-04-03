import { describe, expect, test } from "bun:test";
import { createInitialTemporalView } from "../state/domain-types.js";
import { TemporalView } from "./temporal-view.js";

describe("TemporalView", () => {
  test("is a function component", () => {
    expect(typeof TemporalView).toBe("function");
  });

  test("accepts TemporalViewState props", () => {
    const props = {
      temporalView: createInitialTemporalView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.temporalView.events).toEqual([]);
    expect(props.temporalView.scrollOffset).toBe(0);
    expect(props.temporalView.health).toBeNull();
    expect(props.temporalView.workflows).toEqual([]);
  });

  test("initial state has null health and empty workflows", () => {
    const state = createInitialTemporalView();
    expect(state.health).toBeNull();
    expect(state.workflows).toHaveLength(0);
    expect(state.selectedWorkflowIndex).toBe(0);
    expect(state.workflowDetail).toBeNull();
  });
});
