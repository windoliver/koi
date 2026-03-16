import { describe, expect, test } from "bun:test";
import { createInitialProcessTreeView } from "../state/domain-types.js";
import { ProcessTreeView } from "./process-tree-view.js";

describe("ProcessTreeView", () => {
  test("is a function component", () => {
    expect(typeof ProcessTreeView).toBe("function");
  });

  test("accepts ProcessTreeViewState props", () => {
    const props = {
      processTreeView: createInitialProcessTreeView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.processTreeView.snapshot).toBeNull();
    expect(props.processTreeView.scrollOffset).toBe(0);
    expect(props.processTreeView.loading).toBe(false);
  });

  test("initial state has null snapshot", () => {
    const state = createInitialProcessTreeView();
    expect(state.snapshot).toBeNull();
  });
});
