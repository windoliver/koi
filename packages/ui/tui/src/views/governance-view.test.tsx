import { describe, expect, test } from "bun:test";
import { createInitialGovernanceView } from "../state/domain-types.js";
import { GovernanceView } from "./governance-view.js";

describe("GovernanceView", () => {
  test("is a function component", () => {
    expect(typeof GovernanceView).toBe("function");
  });

  test("accepts GovernanceViewState props", () => {
    const props = {
      governanceView: createInitialGovernanceView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.governanceView.pendingApprovals).toEqual([]);
    expect(props.governanceView.violations).toEqual([]);
    expect(props.governanceView.scrollOffset).toBe(0);
    expect(props.governanceView.selectedIndex).toBe(0);
  });

  test("initial state has empty pendingApprovals and violations", () => {
    const state = createInitialGovernanceView();
    expect(state.pendingApprovals).toHaveLength(0);
    expect(state.violations).toHaveLength(0);
  });
});
