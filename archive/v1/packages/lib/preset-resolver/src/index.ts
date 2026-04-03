/**
 * @koi/preset-resolver — Generic 3-layer config resolution (L0u).
 *
 * Exports building blocks for the "defaults → preset → user overrides" pattern:
 * - `deepMerge()` — recursive plain-object merge
 * - `lookupPreset()` — preset name resolution with default fallback
 * - `resolvePreset()` — full 3-layer merge for simple cases
 * - `DeepPartial<T>` — type utility
 */

export { deepMerge } from "./deep-merge.js";
export { lookupPreset } from "./lookup-preset.js";
export { resolvePreset } from "./resolve-preset.js";
export type { DeepPartial } from "./types.js";
