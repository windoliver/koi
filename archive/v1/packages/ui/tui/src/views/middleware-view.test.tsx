import { describe, expect, test } from "bun:test";
import { createInitialMiddlewareView } from "../state/domain-types.js";
import { MiddlewareView } from "./middleware-view.js";

describe("MiddlewareView", () => {
  test("is a function component", () => {
    expect(typeof MiddlewareView).toBe("function");
  });

  test("accepts MiddlewareViewState props", () => {
    const props = {
      middlewareView: createInitialMiddlewareView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.middlewareView.chain).toBeNull();
    expect(props.middlewareView.scrollOffset).toBe(0);
    expect(props.middlewareView.loading).toBe(false);
  });

  test("initial state has null chain and loading false", () => {
    const state = createInitialMiddlewareView();
    expect(state.chain).toBeNull();
    expect(state.loading).toBe(false);
  });
});
