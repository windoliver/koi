import { beforeEach, describe, expect, test } from "bun:test";
import { SAVED_VIEWS } from "@koi/dashboard-types";
import { cleanup, render, screen } from "../../__tests__/setup.js";
import { useViewStore } from "../../stores/view-store.js";
import { SavedViewTabs } from "./saved-view-tabs.js";

describe("SavedViewTabs", () => {
  beforeEach(() => {
    useViewStore.setState({
      activeViewId: "all",
      activeView: SAVED_VIEWS[0]!,
    });
    cleanup();
  });

  test("renders all saved view tabs", () => {
    render(<SavedViewTabs />);
    for (const view of SAVED_VIEWS) {
      expect(screen.getByText(view.label)).toBeDefined();
    }
  });

  test("clicking a tab changes the active view", () => {
    render(<SavedViewTabs />);
    const agentsTab = screen.getByText("Agents");
    agentsTab.click();
    expect(useViewStore.getState().activeViewId).toBe("agents");
  });
});
