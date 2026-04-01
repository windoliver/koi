/**
 * @koi/config — Runtime policy configuration.
 *
 * Provides Zod schemas, YAML/JSON loading with env interpolation, a reactive
 * config store, $include composition, file watching, and a KoiConfig-to-engine bridge.
 */

export type { ProcessIncludesOptions } from "./include.js";
export { processIncludes } from "./include.js";
export type { LoadConfigOptions } from "./loader.js";
// Tier 3: loader + include
export { interpolateEnv, loadConfig, loadConfigFromString } from "./loader.js";
export { maskConfig, SENSITIVE_PATTERN } from "./mask.js";
// Tier 1: zero-dependency modules
export { deepMerge } from "./merge.js";
export type { ConfigManager, CreateConfigManagerOptions } from "./reload.js";
// Tier 5: ConfigManager
export { createConfigManager, DEFAULT_KOI_CONFIG } from "./reload.js";
// Tier 4: resolve
export { resolveConfig } from "./resolve.js";
export type { ResolvedKoiOptions } from "./resolve-options.js";
export { resolveKoiOptions } from "./resolve-options.js";
// Tier 2: schema + validation
export { getKoiConfigJsonSchema, validateKoiConfig } from "./schema.js";
export { selectConfig } from "./select.js";
export type { WritableConfigStore } from "./store.js";
export { createConfigStore } from "./store.js";
export type { WatchConfigOptions } from "./watcher.js";
export { watchConfigFile } from "./watcher.js";
