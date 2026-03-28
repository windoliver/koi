/**
 * Tests for ForgeView — OpenTUI React component rendering.
 */

import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { ForgeViewProps, ForgeViewState } from "./forge-view.js";
import { ForgeView } from "./forge-view.js";

function createEmptyForgeState(): ForgeViewState {
  return {
    forgeBricks: {},
    forgeSparklines: {},
    forgeEvents: [],
    monitorEvents: [],
    forgeSelectedBrickIndex: 0,
  };
}

function makeProps(overrides?: Partial<ForgeViewProps>): ForgeViewProps {
  return {
    state: createEmptyForgeState(),
    focused: false,
    ...overrides,
  };
}

describe("ForgeView", () => {
  test("is a function component", () => {
    expect(typeof ForgeView).toBe("function");
  });

  test("accepts ForgeViewState props", () => {
    const props: ForgeViewProps = {
      state: createEmptyForgeState(),
      focused: true,
      zoomLevel: "normal",
    };
    expect(props.state.forgeBricks).toEqual({});
    expect(props.state.forgeEvents).toEqual([]);
  });

  test("empty state has zero selected index", () => {
    const state = createEmptyForgeState();
    expect(state.forgeSelectedBrickIndex).toBe(0);
  });

  test("renders empty state when no bricks", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      <ForgeView {...makeProps()} />,
      { width: 120, height: 20 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("No bricks forged yet");
  });

  test("renders brick names in table", async () => {
    const state: ForgeViewState = {
      forgeBricks: {
        "b1": { name: "json-parser", status: "active", fitness: 0.85 },
        "b2": { name: "csv-reader", status: "draft", fitness: 0.4 },
      },
      forgeSparklines: {},
      forgeEvents: [],
      monitorEvents: [],
      forgeSelectedBrickIndex: 0,
    };

    const { captureCharFrame, renderOnce } = await testRender(
      <ForgeView {...makeProps({ state })} />,
      { width: 120, height: 20 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("json-parser");
    expect(frame).toContain("csv-reader");
  });

  test("truncates brick names at narrow tier", async () => {
    const state: ForgeViewState = {
      forgeBricks: {
        "b1": { name: "very-long-brick-name-that-exceeds", status: "active", fitness: 0.5 },
      },
      forgeSparklines: {},
      forgeEvents: [],
      monitorEvents: [],
      forgeSelectedBrickIndex: 0,
    };

    const { captureCharFrame, renderOnce } = await testRender(
      <ForgeView {...makeProps({ state, layoutTier: "narrow" })} />,
      { width: 80, height: 20 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    // Narrow tier uses nameWidth=16, so the long name gets truncated
    expect(frame).toContain("very-long-brick-");
    expect(frame).not.toContain("very-long-brick-name-that-exceeds");
  });

  test("shows promoted count with accent", async () => {
    const state: ForgeViewState = {
      forgeBricks: {
        "b1": { name: "promoted-brick", status: "promoted", fitness: 0.95 },
        "b2": { name: "draft-brick", status: "draft", fitness: 0.3 },
      },
      forgeSparklines: {},
      forgeEvents: [],
      monitorEvents: [],
      forgeSelectedBrickIndex: 0,
    };

    const { captureCharFrame, renderOnce } = await testRender(
      <ForgeView {...makeProps({ state })} />,
      { width: 120, height: 20 },
    );

    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Promoted:");
  });
});
