/**
 * @koi/config — Runtime policy configuration.
 *
 * Provides Zod schemas, YAML/JSON loading with env interpolation, a reactive
 * config store, $include composition, file watching, a reload event bus,
 * field classification (hot vs restart), and a KoiConfig-to-engine bridge.
 */

// Tier 1: classification + diff (pure, zero-dependency)
export type { ClassifiedPaths, ReloadClass } from "./classification.js";
export {
  classifyChangedPaths,
  FIELD_CLASSIFICATION,
  UNCLASSIFIED_SECTIONS,
} from "./classification.js";
export type { ConfigChange, ConfigConsumer } from "./consumer.js";
export type { ChangedPath } from "./diff.js";
export { diffConfig } from "./diff.js";
// Tier 2: event bus
export type { ConfigRejectReason, ConfigReloadEvent } from "./events.js";
export { createConfigEventBus } from "./events.js";
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
