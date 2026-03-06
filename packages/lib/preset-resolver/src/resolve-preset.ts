/**
 * Full 3-layer config resolution: defaults → preset → user overrides.
 */

import { deepMerge } from "./deep-merge.js";
import { lookupPreset } from "./lookup-preset.js";
import type { DeepPartial } from "./types.js";

/**
 * Resolves a 3-layer config: merges `defaults` → `preset spec` → `user overrides`.
 *
 * 1. Looks up the preset (or falls back to `defaultPreset`).
 * 2. Deep-merges the preset spec over the defaults.
 * 3. Deep-merges the user config over the result.
 *
 * The `preset` key in `config` is used for lookup but stripped from the merge.
 */
export function resolvePreset<T extends Record<string, unknown>, P extends string>(
  defaults: Readonly<T>,
  specs: Readonly<Record<P, DeepPartial<T>>>,
  defaultPreset: NoInfer<P>,
  config: DeepPartial<T> & { readonly preset?: P | undefined },
): { readonly preset: P; readonly resolved: Readonly<T> } {
  const { preset, spec } = lookupPreset(specs, config.preset, defaultPreset);

  // Layer 1 → 2: merge preset spec over defaults
  const withPreset = deepMerge(defaults, spec as Partial<T>);

  // Layer 2 → 3: merge user config over preset
  // deepMerge only iterates base keys, so passing `config` directly is safe —
  // the extra `preset` key is simply ignored (not present in `defaults`).
  const resolved = deepMerge(withPreset, config as Partial<T>);

  return { preset, resolved };
}
