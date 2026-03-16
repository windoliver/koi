import { describe, expect, test } from "bun:test";
import { createInitialSystemView } from "../state/domain-types.js";
import { SystemView } from "./system-view.js";

describe("SystemView", () => {
  test("is a function component", () => {
    expect(typeof SystemView).toBe("function");
  });

  test("accepts SystemViewState props", () => {
    const props = {
      systemView: createInitialSystemView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.systemView.events).toEqual([]);
    expect(props.systemView.scrollOffset).toBe(0);
  });

  test("initial state has empty events array", () => {
    const state = createInitialSystemView();
    expect(Array.isArray(state.events)).toBe(true);
    expect(state.events).toHaveLength(0);
  });
});
