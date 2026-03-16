import { describe, expect, test } from "bun:test";
import { createInitialGatewayView } from "../state/domain-types.js";
import { GatewayView } from "./gateway-view.js";

describe("GatewayView", () => {
  test("is a function component", () => {
    expect(typeof GatewayView).toBe("function");
  });

  test("accepts GatewayViewState props", () => {
    const props = {
      gatewayView: createInitialGatewayView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.gatewayView.events).toEqual([]);
    expect(props.gatewayView.scrollOffset).toBe(0);
    expect(props.gatewayView.topology).toBeNull();
  });

  test("initial state has null topology", () => {
    const state = createInitialGatewayView();
    expect(state.topology).toBeNull();
  });
});
