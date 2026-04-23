/**
 * @koi/settings — Hierarchical settings cascade: user → project → local → flag → policy
 *
 * Public API: types and loader functions.
 */

export { loadSettings } from "./loader.js";
export { mergeSettings } from "./merge.js";
export type { SettingsPaths } from "./paths.js";
export { resolveSettingsPaths } from "./paths.js";
export { getSettingsJsonSchema, validateKoiSettings } from "./schema.js";
export type {
  KoiSettings,
  SettingsLayer,
  SettingsLoadOptions,
  SettingsLoadResult,
  ValidationError,
} from "./types.js";
