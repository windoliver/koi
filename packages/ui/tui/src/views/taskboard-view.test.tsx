import { describe, expect, test } from "bun:test";
import { createInitialTaskBoardView } from "../state/domain-types.js";
import { TaskBoardView } from "./taskboard-view.js";

describe("TaskBoardView", () => {
  test("is a function component", () => {
    expect(typeof TaskBoardView).toBe("function");
  });

  test("accepts TaskBoardViewState props", () => {
    const props = {
      taskBoardView: createInitialTaskBoardView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.taskBoardView.events).toEqual([]);
    expect(props.taskBoardView.scrollOffset).toBe(0);
    expect(props.taskBoardView.snapshot).toBeNull();
    expect(props.taskBoardView.cachedLayout).toBeNull();
  });

  test("initial state has null snapshot and null cachedLayout", () => {
    const state = createInitialTaskBoardView();
    expect(state.snapshot).toBeNull();
    expect(state.cachedLayout).toBeNull();
    expect(state.layoutNodeCount).toBe(0);
    expect(state.layoutEdgeCount).toBe(0);
  });
});
