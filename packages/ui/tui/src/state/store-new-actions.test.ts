import { describe, expect, test } from "bun:test";
import { reduce } from "./store.js";
import type { PresetInfo, TuiState } from "./types.js";
import { createInitialState } from "./types.js";

const BASE_STATE = createInitialState("http://localhost:3100");

const PRESET_STARTER: PresetInfo = {
  id: "starter",
  description: "Basic setup",
  nexusMode: "local",
  demoPack: undefined,
  services: {},
  stacks: {},
};

const PRESET_ADVANCED: PresetInfo = {
  id: "advanced",
  description: "Advanced setup with monitoring",
  nexusMode: "cloud",
  demoPack: "demo-pack-1",
  services: { monitor: true },
  stacks: { forge: true },
};

const PRESET_ENTERPRISE: PresetInfo = {
  id: "enterprise",
  description: "Full enterprise deployment",
  nexusMode: "hybrid",
  demoPack: "demo-pack-2",
  services: { monitor: true, gateway: true },
  stacks: { forge: true, arena: true },
};

const SAMPLE_PRESETS: readonly PresetInfo[] = [PRESET_STARTER, PRESET_ADVANCED, PRESET_ENTERPRISE];

// ─── set_zoom_level ─────────────────────────────────────────────────────

describe("reduce — set_zoom_level", () => {
  test("sets zoom level to half", () => {
    const next = reduce(BASE_STATE, { kind: "set_zoom_level", level: "half" });
    expect(next.zoomLevel).toBe("half");
  });

  test("sets zoom level to full", () => {
    const next = reduce(BASE_STATE, { kind: "set_zoom_level", level: "full" });
    expect(next.zoomLevel).toBe("full");
  });

  test("sets zoom level back to normal", () => {
    const state: TuiState = { ...BASE_STATE, zoomLevel: "full" };
    const next = reduce(state, { kind: "set_zoom_level", level: "normal" });
    expect(next.zoomLevel).toBe("normal");
  });

  test("preserves other state fields", () => {
    const state: TuiState = { ...BASE_STATE, view: "console" };
    const next = reduce(state, { kind: "set_zoom_level", level: "half" });
    expect(next.view).toBe("console");
    expect(next.zoomLevel).toBe("half");
  });
});

// ─── cycle_zoom ─────────────────────────────────────────────────────────

describe("reduce — cycle_zoom", () => {
  test("cycles from normal to half", () => {
    const state: TuiState = { ...BASE_STATE, zoomLevel: "normal" };
    const next = reduce(state, { kind: "cycle_zoom" });
    expect(next.zoomLevel).toBe("half");
  });

  test("cycles from half to full", () => {
    const state: TuiState = { ...BASE_STATE, zoomLevel: "half" };
    const next = reduce(state, { kind: "cycle_zoom" });
    expect(next.zoomLevel).toBe("full");
  });

  test("cycles from full back to normal", () => {
    const state: TuiState = { ...BASE_STATE, zoomLevel: "full" };
    const next = reduce(state, { kind: "cycle_zoom" });
    expect(next.zoomLevel).toBe("normal");
  });

  test("full cycle returns to original zoom level", () => {
    let state: TuiState = { ...BASE_STATE, zoomLevel: "normal" };
    state = reduce(state, { kind: "cycle_zoom" }); // normal -> half
    state = reduce(state, { kind: "cycle_zoom" }); // half -> full
    state = reduce(state, { kind: "cycle_zoom" }); // full -> normal
    expect(state.zoomLevel).toBe("normal");
  });
});

// ─── set_presets ────────────────────────────────────────────────────────

describe("reduce — set_presets", () => {
  test("sets presets list", () => {
    const next = reduce(BASE_STATE, { kind: "set_presets", presets: SAMPLE_PRESETS });
    expect(next.presets).toHaveLength(3);
    expect(next.presets[0]?.id).toBe("starter");
    expect(next.presets[2]?.id).toBe("enterprise");
  });

  test("replaces existing presets", () => {
    const state: TuiState = { ...BASE_STATE, presets: SAMPLE_PRESETS };
    const newPresets: readonly PresetInfo[] = [
      {
        id: "minimal",
        description: "Minimal",
        nexusMode: "local",
        demoPack: undefined,
        services: {},
        stacks: {},
      },
    ];
    const next = reduce(state, { kind: "set_presets", presets: newPresets });
    expect(next.presets).toHaveLength(1);
    expect(next.presets[0]?.id).toBe("minimal");
  });

  test("handles empty presets list", () => {
    const state: TuiState = { ...BASE_STATE, presets: SAMPLE_PRESETS };
    const next = reduce(state, { kind: "set_presets", presets: [] });
    expect(next.presets).toEqual([]);
  });
});

// ─── select_preset ──────────────────────────────────────────────────────

describe("reduce — select_preset", () => {
  const stateWithPresets: TuiState = { ...BASE_STATE, presets: SAMPLE_PRESETS };

  test("selects a valid index", () => {
    const next = reduce(stateWithPresets, { kind: "select_preset", index: 1 });
    expect(next.selectedPresetIndex).toBe(1);
  });

  test("selects first preset", () => {
    const next = reduce(stateWithPresets, { kind: "select_preset", index: 0 });
    expect(next.selectedPresetIndex).toBe(0);
  });

  test("selects last preset", () => {
    const next = reduce(stateWithPresets, { kind: "select_preset", index: 2 });
    expect(next.selectedPresetIndex).toBe(2);
  });

  test("clamps negative index to 0", () => {
    const next = reduce(stateWithPresets, { kind: "select_preset", index: -5 });
    expect(next.selectedPresetIndex).toBe(0);
  });

  test("clamps overflow index to last element", () => {
    const next = reduce(stateWithPresets, { kind: "select_preset", index: 100 });
    expect(next.selectedPresetIndex).toBe(2);
  });

  test("clamps to 0 when presets list is empty", () => {
    const emptyState: TuiState = { ...BASE_STATE, presets: [] };
    const next = reduce(emptyState, { kind: "select_preset", index: 5 });
    // Math.min(5, Math.max(0, 0 - 1)) = Math.min(5, 0) = 0
    expect(next.selectedPresetIndex).toBe(0);
  });
});

// ─── set_active_preset_detail ───────────────────────────────────────────

describe("reduce — set_active_preset_detail", () => {
  test("sets active preset detail", () => {
    const next = reduce(BASE_STATE, { kind: "set_active_preset_detail", detail: PRESET_ADVANCED });
    expect(next.activePresetDetail).toBe(PRESET_ADVANCED);
    expect(next.activePresetDetail?.id).toBe("advanced");
  });

  test("clears active preset detail with null", () => {
    const state: TuiState = { ...BASE_STATE, activePresetDetail: PRESET_STARTER };
    const next = reduce(state, { kind: "set_active_preset_detail", detail: null });
    expect(next.activePresetDetail).toBeNull();
  });

  test("replaces existing preset detail", () => {
    const state: TuiState = { ...BASE_STATE, activePresetDetail: PRESET_STARTER };
    const next = reduce(state, {
      kind: "set_active_preset_detail",
      detail: PRESET_ENTERPRISE,
    });
    expect(next.activePresetDetail?.id).toBe("enterprise");
  });

  test("preserves other state fields when setting detail", () => {
    const state: TuiState = {
      ...BASE_STATE,
      view: "welcome",
      presets: SAMPLE_PRESETS,
      selectedPresetIndex: 1,
    };
    const next = reduce(state, {
      kind: "set_active_preset_detail",
      detail: PRESET_ADVANCED,
    });
    expect(next.view).toBe("welcome");
    expect(next.presets).toHaveLength(3);
    expect(next.selectedPresetIndex).toBe(1);
    expect(next.activePresetDetail?.id).toBe("advanced");
  });
});
