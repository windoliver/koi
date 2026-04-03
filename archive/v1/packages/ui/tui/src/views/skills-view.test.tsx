import { describe, expect, test } from "bun:test";
import { createInitialSkillsView } from "../state/domain-types.js";
import { SkillsView } from "./skills-view.js";

describe("SkillsView", () => {
  test("is a function component", () => {
    expect(typeof SkillsView).toBe("function");
  });

  test("accepts SkillsViewState props", () => {
    const props = {
      skillsView: createInitialSkillsView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.skillsView.events).toEqual([]);
    expect(props.skillsView.scrollOffset).toBe(0);
  });

  test("initial state has empty events array", () => {
    const state = createInitialSkillsView();
    expect(Array.isArray(state.events)).toBe(true);
    expect(state.events).toHaveLength(0);
  });
});
