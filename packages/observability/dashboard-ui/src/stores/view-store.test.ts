import { beforeEach, describe, expect, test } from "bun:test";
import type { SavedViewDefinition } from "@koi/dashboard-types";
import { SAVED_VIEWS } from "@koi/dashboard-types";
import { useViewStore } from "./view-store.js";

const DEFAULT_VIEW: SavedViewDefinition = SAVED_VIEWS[0] ?? {
  id: "all",
  label: "All Files",
  rootPaths: ["/"],
  urlParam: "all",
};

describe("view-store", () => {
  beforeEach(() => {
    useViewStore.setState({
      activeViewId: "all",
      activeView: DEFAULT_VIEW,
    });
  });

  test("initial view is 'all'", () => {
    expect(useViewStore.getState().activeViewId).toBe("all");
    expect(useViewStore.getState().activeView.label).toBe("All Files");
  });

  test("setActiveView changes to valid view", () => {
    useViewStore.getState().setActiveView("agents");
    const state = useViewStore.getState();
    expect(state.activeViewId).toBe("agents");
    expect(state.activeView.label).toBe("Agents");
  });

  test("setActiveView falls back to first view for unknown id", () => {
    useViewStore.getState().setActiveView("nonexistent");
    const state = useViewStore.getState();
    expect(state.activeView.id).toBe("all");
  });

  test("activeView rootPaths match the saved view definition", () => {
    useViewStore.getState().setActiveView("forge");
    const { activeView } = useViewStore.getState();
    expect(activeView.rootPaths).toEqual(["/agents/", "/global/bricks/"]);
  });

  test("all built-in views are selectable", () => {
    for (const view of SAVED_VIEWS) {
      useViewStore.getState().setActiveView(view.id);
      expect(useViewStore.getState().activeViewId).toBe(view.id);
      expect(useViewStore.getState().activeView.id).toBe(view.id);
    }
  });
});
