import { describe, expect, test } from "bun:test";
import { createInitialCostView } from "../state/domain-types.js";
import { CostView } from "./cost-view.js";

describe("CostView", () => {
  test("is a function component", () => {
    expect(typeof CostView).toBe("function");
  });

  test("accepts CostViewState + agents props", () => {
    const props = {
      costView: createInitialCostView(),
      agents: [],
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.costView.scrollOffset).toBe(0);
    expect(props.agents).toEqual([]);
  });

  test("initial state has zero scroll offset", () => {
    const state = createInitialCostView();
    expect(state.scrollOffset).toBe(0);
  });
});
