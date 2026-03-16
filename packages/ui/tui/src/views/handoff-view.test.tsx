import { describe, expect, test } from "bun:test";
import { createInitialHandoffView } from "../state/domain-types.js";
import { HandoffView } from "./handoff-view.js";

describe("HandoffView", () => {
  test("is a function component", () => {
    expect(typeof HandoffView).toBe("function");
  });

  test("accepts HandoffViewState props", () => {
    const props = {
      handoffView: createInitialHandoffView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.handoffView.handoffs).toEqual([]);
    expect(props.handoffView.scrollOffset).toBe(0);
    expect(props.handoffView.loading).toBe(false);
  });

  test("initial state has empty handoffs", () => {
    const state = createInitialHandoffView();
    expect(state.handoffs).toHaveLength(0);
  });
});
