import { describe, expect, test } from "bun:test";
import { createInitialScratchpadView } from "../state/domain-types.js";
import { ScratchpadView } from "./scratchpad-view.js";

describe("ScratchpadView", () => {
  test("is a function component", () => {
    expect(typeof ScratchpadView).toBe("function");
  });

  test("accepts ScratchpadViewState props", () => {
    const props = {
      scratchpadView: createInitialScratchpadView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.scratchpadView.entries).toEqual([]);
    expect(props.scratchpadView.selectedEntry).toBe(null);
    expect(props.scratchpadView.scrollOffset).toBe(0);
    expect(props.scratchpadView.loading).toBe(false);
    expect(props.scratchpadView.currentPath).toBe(null);
  });

  test("initial state has empty entries", () => {
    const state = createInitialScratchpadView();
    expect(state.entries).toHaveLength(0);
  });
});
