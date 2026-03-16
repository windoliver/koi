/**
 * Tests for first-run tooltip state management.
 */

import { describe, expect, test } from "bun:test";
import {
  dismissTooltip,
  recordSessionStart,
  shouldShowTooltip,
  type TuiPersistentState,
} from "./first-run.js";

const EMPTY_STATE: TuiPersistentState = {
  dismissedTooltips: [],
  firstLaunchAt: undefined,
  sessionCount: 0,
};

describe("shouldShowTooltip", () => {
  test("returns true for undismissed tooltip", () => {
    expect(shouldShowTooltip(EMPTY_STATE, "welcome_preset_picker")).toBe(true);
  });

  test("returns false for dismissed tooltip", () => {
    const state: TuiPersistentState = {
      ...EMPTY_STATE,
      dismissedTooltips: ["welcome_preset_picker"],
    };
    expect(shouldShowTooltip(state, "welcome_preset_picker")).toBe(false);
  });

  test("returns true for other tooltips when one is dismissed", () => {
    const state: TuiPersistentState = {
      ...EMPTY_STATE,
      dismissedTooltips: ["welcome_preset_picker"],
    };
    expect(shouldShowTooltip(state, "agents_navigation")).toBe(true);
  });
});

describe("dismissTooltip", () => {
  test("adds tooltip to dismissed list", () => {
    const result = dismissTooltip(EMPTY_STATE, "zoom_hint");
    expect(result.dismissedTooltips).toContain("zoom_hint");
  });

  test("does not duplicate already-dismissed tooltip", () => {
    const state: TuiPersistentState = {
      ...EMPTY_STATE,
      dismissedTooltips: ["zoom_hint"],
    };
    const result = dismissTooltip(state, "zoom_hint");
    expect(result).toBe(state); // Same reference — no change
  });

  test("preserves other state fields", () => {
    const state: TuiPersistentState = {
      dismissedTooltips: ["agents_navigation"],
      firstLaunchAt: 1000,
      sessionCount: 5,
    };
    const result = dismissTooltip(state, "zoom_hint");
    expect(result.firstLaunchAt).toBe(1000);
    expect(result.sessionCount).toBe(5);
    expect(result.dismissedTooltips).toEqual(["agents_navigation", "zoom_hint"]);
  });

  test("returns new object (immutable)", () => {
    const result = dismissTooltip(EMPTY_STATE, "palette_hint");
    expect(result).not.toBe(EMPTY_STATE);
  });
});

describe("recordSessionStart", () => {
  test("sets firstLaunchAt on first session", () => {
    const result = recordSessionStart(EMPTY_STATE);
    expect(result.firstLaunchAt).toBeGreaterThan(0);
    expect(result.sessionCount).toBe(1);
  });

  test("preserves firstLaunchAt on subsequent sessions", () => {
    const state: TuiPersistentState = {
      ...EMPTY_STATE,
      firstLaunchAt: 42,
      sessionCount: 3,
    };
    const result = recordSessionStart(state);
    expect(result.firstLaunchAt).toBe(42);
    expect(result.sessionCount).toBe(4);
  });

  test("increments session count", () => {
    let state = EMPTY_STATE;
    state = recordSessionStart(state);
    state = recordSessionStart(state);
    state = recordSessionStart(state);
    expect(state.sessionCount).toBe(3);
  });
});
