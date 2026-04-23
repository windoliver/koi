/**
 * @koi/settings — Hierarchical settings cascade: user → project → local → flag → policy
 *
 * Public API: types and loader functions.
 */

export { getSettingsJsonSchema, validateKoiSettings } from "./schema.js";
export { loadSettings } from "./loader.js";
export { mergeSettings } from "./merge.js";
export { resolveSettingsPaths } from "./paths.js";
export type { SettingsPaths } from "./paths.js";
export type {
  HookCommand,
  HookEventName,
  KoiSettings,
  SettingsLayer,
  SettingsLoadOptions,
  SettingsLoadResult,
  ValidationError,
} from "./types.js";
