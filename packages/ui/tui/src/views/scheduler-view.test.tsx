import { describe, expect, test } from "bun:test";
import { createInitialSchedulerView } from "../state/domain-types.js";
import { SchedulerView } from "./scheduler-view.js";

describe("SchedulerView", () => {
  test("is a function component", () => {
    expect(typeof SchedulerView).toBe("function");
  });

  test("accepts SchedulerViewState props", () => {
    const props = {
      schedulerView: createInitialSchedulerView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.schedulerView.events).toEqual([]);
    expect(props.schedulerView.scrollOffset).toBe(0);
    expect(props.schedulerView.stats).toBeNull();
    expect(props.schedulerView.tasks).toEqual([]);
  });

  test("initial state has null stats and empty collections", () => {
    const state = createInitialSchedulerView();
    expect(state.stats).toBeNull();
    expect(state.tasks).toHaveLength(0);
    expect(state.schedules).toHaveLength(0);
    expect(state.deadLetters).toHaveLength(0);
  });
});
