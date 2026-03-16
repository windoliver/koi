import { describe, expect, test } from "bun:test";
import { createInitialDelegationView } from "../state/domain-types.js";
import { DelegationView } from "./delegation-view.js";

describe("DelegationView", () => {
  test("is a function component", () => {
    expect(typeof DelegationView).toBe("function");
  });

  test("accepts DelegationViewState props", () => {
    const props = {
      delegationView: createInitialDelegationView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.delegationView.delegations).toEqual([]);
    expect(props.delegationView.scrollOffset).toBe(0);
    expect(props.delegationView.loading).toBe(false);
  });

  test("initial state has empty delegations", () => {
    const state = createInitialDelegationView();
    expect(state.delegations).toHaveLength(0);
  });
});
