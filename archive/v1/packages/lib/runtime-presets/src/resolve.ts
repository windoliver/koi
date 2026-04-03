/**
 * Preset resolution — resolves a preset ID to a full RuntimePreset
 * using @koi/preset-resolver for 3-layer merge.
 */

import type { DeepPartial } from "@koi/preset-resolver";
import { deepMerge, lookupPreset } from "@koi/preset-resolver";
import { ADDONS } from "./addons.js";
import { DEMO_PRESET } from "./presets/demo.js";
import { LOCAL_PRESET } from "./presets/local.js";
import { MESH_PRESET } from "./presets/mesh.js";
import { SQLITE_PRESET } from "./presets/sqlite.js";
import type { AddOn, PresetId, RuntimePreset } from "./types.js";

// ---------------------------------------------------------------------------
// Preset registry
// ---------------------------------------------------------------------------

const PRESET_REGISTRY: Readonly<Record<PresetId, RuntimePreset>> = {
  local: LOCAL_PRESET,
  demo: DEMO_PRESET,
  mesh: MESH_PRESET,
  sqlite: SQLITE_PRESET,
} as const;

/** All known preset IDs (for validation and CLI help). */
export const PRESET_IDS: readonly PresetId[] = ["local", "demo", "mesh", "sqlite"] as const;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Looks up a preset by ID. Returns the preset or the default (local).
 */
export function getPreset(id: PresetId): RuntimePreset {
  const result = lookupPreset(PRESET_REGISTRY, id, "local");
  return PRESET_REGISTRY[result.preset as PresetId] ?? LOCAL_PRESET;
}

/**
 * Resolves a full preset with optional overrides.
 * Uses 3-layer merge: defaults (local) → preset spec → user overrides.
 */
export function resolveRuntimePreset(
  presetId: PresetId,
  overrides?: DeepPartial<RuntimePreset>,
): { readonly preset: PresetId; readonly resolved: RuntimePreset } {
  const specs: Readonly<Record<PresetId, DeepPartial<RuntimePreset>>> = {
    local: LOCAL_PRESET,
    demo: DEMO_PRESET,
    mesh: MESH_PRESET,
    sqlite: SQLITE_PRESET,
  };

  const config: DeepPartial<RuntimePreset> & { readonly preset?: PresetId } = {
    ...(overrides ?? {}),
    preset: presetId,
  };

  const result = lookupPreset(specs, presetId, "local");
  const withPreset = deepMerge(
    LOCAL_PRESET as unknown as Record<string, unknown>,
    result.spec as Partial<Record<string, unknown>>,
  );
  const resolved = deepMerge(withPreset, (config ?? {}) as Partial<Record<string, unknown>>);

  return {
    preset: result.preset as PresetId,
    resolved: resolved as unknown as RuntimePreset,
  };
}

/**
 * Resolves add-ons by ID. Returns unknown add-on IDs for error reporting.
 */
export function resolveAddons(addonIds: readonly string[]): {
  readonly addons: readonly AddOn[];
  readonly unknown: readonly string[];
} {
  const addons: AddOn[] = [];
  const unknown: string[] = [];

  for (const id of addonIds) {
    const addon = ADDONS[id];
    if (addon !== undefined) {
      addons.push(addon);
    } else {
      unknown.push(id);
    }
  }

  return { addons, unknown };
}
