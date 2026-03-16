import { describe, expect, test } from "bun:test";
import { createInitialHarnessView } from "../state/domain-types.js";
import { HarnessView } from "./harness-view.js";

describe("HarnessView", () => {
  test("is a function component", () => {
    expect(typeof HarnessView).toBe("function");
  });

  test("accepts HarnessViewState props", () => {
    const props = {
      harnessView: createInitialHarnessView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.harnessView.events).toEqual([]);
    expect(props.harnessView.scrollOffset).toBe(0);
    expect(props.harnessView.status).toBeNull();
    expect(props.harnessView.checkpoints).toEqual([]);
  });

  test("initial state has null status and empty checkpoints", () => {
    const state = createInitialHarnessView();
    expect(state.status).toBeNull();
    expect(state.checkpoints).toHaveLength(0);
  });
});
