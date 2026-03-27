import { describe, expect, test } from "bun:test";
import type { ForgeViewProps, ForgeViewState } from "./forge-view.js";
import { ForgeView } from "./forge-view.js";

function createEmptyForgeState(): ForgeViewState {
  return {
    forgeBricks: {},
    forgeSparklines: {},
    forgeEvents: [],
    monitorEvents: [],
    forgeSelectedBrickIndex: 0,
  };
}

describe("ForgeView", () => {
  test("is a function component", () => {
    expect(typeof ForgeView).toBe("function");
  });

  test("accepts ForgeViewState props", () => {
    const props: ForgeViewProps = {
      state: createEmptyForgeState(),
      focused: true,
      zoomLevel: "normal",
    };
    expect(props.state.forgeBricks).toEqual({});
    expect(props.state.forgeEvents).toEqual([]);
  });

  test("empty state has zero selected index", () => {
    const state = createEmptyForgeState();
    expect(state.forgeSelectedBrickIndex).toBe(0);
  });

  test("accepts optional terminalWidth prop for responsive layout", () => {
    const props: ForgeViewProps = {
      state: createEmptyForgeState(),
      focused: false,
      terminalWidth: 60,
    };
    expect(props.terminalWidth).toBe(60);
  });
});
