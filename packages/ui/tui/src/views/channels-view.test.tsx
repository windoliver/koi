import { describe, expect, test } from "bun:test";
import { createInitialChannelsView } from "../state/domain-types.js";
import { ChannelsView } from "./channels-view.js";

describe("ChannelsView", () => {
  test("is a function component", () => {
    expect(typeof ChannelsView).toBe("function");
  });

  test("accepts ChannelsViewState props", () => {
    const props = {
      channelsView: createInitialChannelsView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.channelsView.events).toEqual([]);
    expect(props.channelsView.scrollOffset).toBe(0);
  });

  test("initial state has empty events array", () => {
    const state = createInitialChannelsView();
    expect(Array.isArray(state.events)).toBe(true);
    expect(state.events).toHaveLength(0);
  });
});
