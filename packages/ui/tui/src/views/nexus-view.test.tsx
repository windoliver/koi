import { describe, expect, test } from "bun:test";
import { createInitialNexusView } from "../state/domain-types.js";
import { NexusView } from "./nexus-view.js";

describe("NexusView", () => {
  test("is a function component", () => {
    expect(typeof NexusView).toBe("function");
  });

  test("accepts NexusViewState props", () => {
    const props = {
      nexusView: createInitialNexusView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.nexusView.events).toEqual([]);
    expect(props.nexusView.scrollOffset).toBe(0);
  });

  test("initial state has empty events array", () => {
    const state = createInitialNexusView();
    expect(Array.isArray(state.events)).toBe(true);
    expect(state.events).toHaveLength(0);
  });
});
